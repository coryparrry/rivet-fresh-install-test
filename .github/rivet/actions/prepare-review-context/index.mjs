import { createHash } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_FILES = 50;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_REPOSITORY_CONTEXT_FILES = 6;
const MAX_REPOSITORY_CONTEXT_BYTES = 24 * 1024;
const MAX_PRIOR_REVIEW_BYTES = 12 * 1024;
const MAX_AGGREGATE_BYTES = 72 * 1024;

function fail(message) {
  throw new Error(`Rivet review context: ${message}`);
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} is invalid`);
  return value;
}

function repositoryPath(value, name = "file path") {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`${name} is invalid`);
  }
  return value;
}

function metadataFromEvent(event, expectedRepository) {
  const repository = event?.repository?.full_name;
  const pullRequest = event?.pull_request;
  if (!REPOSITORY.test(repository ?? "") || repository !== expectedRepository)
    fail("repository identity is invalid");
  const pullNumber = nonnegativeInteger(
    pullRequest?.number,
    "pull request number",
  );
  if (pullNumber < 1) fail("pull request number is invalid");
  const baseSha = pullRequest?.base?.sha;
  const headSha = pullRequest?.head?.sha;
  if (!FULL_SHA.test(baseSha ?? "") || !FULL_SHA.test(headSha ?? ""))
    fail("pull request SHAs are invalid");
  return Object.freeze({
    repository,
    pullNumber,
    baseSha,
    headSha,
    changedFiles: nonnegativeInteger(
      pullRequest?.changed_files,
      "changed file count",
    ),
  });
}

function incomplete(metadata, reason) {
  return Object.freeze({
    schemaVersion: 2,
    complete: false,
    repository: metadata.repository,
    pullNumber: metadata.pullNumber,
    baseSha: metadata.baseSha,
    headSha: metadata.headSha,
    reason,
    files: [],
  });
}

function nestedIncomplete(reason, fields) {
  return Object.freeze({ complete: false, reason, ...fields });
}

function serializePromptSnapshot(snapshot) {
  return JSON.stringify(snapshot).replaceAll("_" + "_GH_AW_", "\\u005f_GH_AW_");
}

function serializedBytes(value) {
  return Buffer.byteLength(serializePromptSnapshot(value), "utf8");
}

async function boundedResponseText(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
    return null;
  if (!response.body?.getReader) fail("GitHub response body is unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function projectFile(file, index) {
  if (!file || typeof file !== "object" || Array.isArray(file))
    fail(`file ${index + 1} is invalid`);
  const status = file.status;
  if (!/^(?:added|copied|modified|removed|renamed)$/.test(status ?? ""))
    fail(`file ${index + 1} status is invalid`);
  const projected = {
    path: repositoryPath(file.filename, `file ${index + 1} path`),
    status,
    additions: nonnegativeInteger(
      file.additions,
      `file ${index + 1} additions`,
    ),
    deletions: nonnegativeInteger(
      file.deletions,
      `file ${index + 1} deletions`,
    ),
    changes: nonnegativeInteger(file.changes, `file ${index + 1} changes`),
    patch: file.patch ?? null,
  };
  if (projected.patch !== null && typeof projected.patch !== "string")
    fail(`file ${index + 1} patch is invalid`);
  if (file.previous_filename !== undefined)
    projected.previousPath = repositoryPath(
      file.previous_filename,
      `file ${index + 1} previous path`,
    );
  return projected;
}

function hasCompletePatch(file, filesByPath) {
  if (file.patch !== null) return true;
  if (file.status === "renamed" && file.changes === 0) return true;
  if (!file.path.endsWith(".lock.yml")) return false;
  const source = filesByPath.get(
    `${file.path.slice(0, -".lock.yml".length)}.md`,
  );
  return source?.changes > 0 && source.patch !== null;
}

function ordinaryContextFile(file) {
  return file.status !== "removed" && !file.path.endsWith(".lock.yml");
}

function decodeBlob(blob, expectedSha) {
  if (
    !blob ||
    typeof blob !== "object" ||
    Array.isArray(blob) ||
    blob.sha !== expectedSha ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string" ||
    !Number.isSafeInteger(blob.size) ||
    blob.size < 0
  ) {
    return null;
  }
  const encoded = blob.content.replaceAll(/\s/gu, "");
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    return null;
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== blob.size || bytes.toString("base64") !== encoded)
    return null;
  const actualSha = createHash("sha1")
    .update(`blob ${bytes.length}\0`, "utf8")
    .update(bytes)
    .digest("hex");
  if (actualSha !== expectedSha) return null;
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return content.includes("\0") ? undefined : content;
  } catch {
    return undefined;
  }
}

function requestUrl(apiBase, pathname, parameters = {}) {
  const url = new URL(pathname, apiBase);
  for (const [name, value] of Object.entries(parameters))
    url.searchParams.set(name, String(value));
  return url;
}

function requestOptions(token) {
  return {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "rivet-review-context",
      "x-github-api-version": "2022-11-28",
    },
  };
}

async function optionalJson(url, token, fetchImpl, maxResponseBytes, label) {
  let response;
  try {
    response = await fetchImpl(url, requestOptions(token));
  } catch {
    return { error: `${label} request failed` };
  }
  if (!response || response.status !== 200)
    return { error: `${label} request failed` };
  let responseText;
  try {
    responseText = await boundedResponseText(response, maxResponseBytes);
  } catch {
    return { error: `${label} response is invalid` };
  }
  if (responseText === null) return { error: `${label} response is too large` };
  try {
    return { value: JSON.parse(responseText), headers: response.headers };
  } catch {
    return { error: `${label} response is invalid` };
  }
}

async function createRepositoryContext({
  apiBase,
  owner,
  repository,
  token,
  rawFiles,
  files,
  fetchImpl,
  maxResponseBytes,
  maxFiles,
  maxBytes,
  headSha,
}) {
  const candidates = files
    .map((file, index) => ({ file, raw: rawFiles[index] }))
    .filter(({ file }) => ordinaryContextFile(file));
  const selected = candidates.slice(0, maxFiles);
  const projected = [];
  let reason =
    candidates.length > maxFiles
      ? `repository context exceeds the ${maxFiles}-file budget`
      : null;
  for (const { file, raw } of selected) {
    if (!FULL_SHA.test(raw?.sha ?? "")) {
      reason = "GitHub comparison omits an exact changed-file blob identity";
      break;
    }
    const result = await optionalJson(
      requestUrl(
        apiBase,
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/blobs/${raw.sha}`,
      ),
      token,
      fetchImpl,
      maxResponseBytes,
      "GitHub repository context",
    );
    if (result.error) {
      reason = result.error;
      break;
    }
    const content = decodeBlob(result.value, raw.sha);
    if (content === null) {
      reason = "GitHub repository context blob is invalid";
      break;
    }
    if (content === undefined) continue;
    const next = [...projected, { path: file.path, blobSha: raw.sha, content }];
    if (
      serializedBytes({ complete: true, refSha: headSha, files: next }) >
      maxBytes
    ) {
      reason = `repository context exceeds the ${maxBytes}-byte budget`;
      break;
    }
    projected.push(next.at(-1));
  }
  return reason
    ? nestedIncomplete(reason, { refSha: headSha, files: [] })
    : Object.freeze({ complete: true, refSha: headSha, files: projected });
}

function authorIdentity(item, label) {
  const user = item?.user;
  if (
    !Number.isSafeInteger(user?.id) ||
    user.id < 1 ||
    typeof user.login !== "string" ||
    user.login.length < 1 ||
    user.login.length > 256 ||
    typeof user.type !== "string" ||
    user.type.length < 1 ||
    user.type.length > 64
  ) {
    fail(`${label} author is invalid`);
  }
  return { id: user.id, login: user.login, type: user.type };
}

function bodyText(value, label) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") fail(`${label} body is invalid`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    fail(`${label} timestamp is invalid`);
  return value;
}

function projectReview(review, index) {
  const label = `review ${index + 1}`;
  if (!review || typeof review !== "object" || Array.isArray(review))
    fail(`${label} is invalid`);
  if (!Number.isSafeInteger(review.id) || review.id < 1)
    fail(`${label} identity is invalid`);
  if (!FULL_SHA.test(review.commit_id ?? ""))
    fail(`${label} commit identity is invalid`);
  if (typeof review.state !== "string" || !review.state)
    fail(`${label} state is invalid`);
  return {
    id: review.id,
    author: authorIdentity(review, label),
    state: review.state,
    commitSha: review.commit_id,
    submittedAt: timestamp(review.submitted_at, label),
    body: bodyText(review.body, label),
  };
}

function optionalLine(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is invalid`);
  return value;
}

function projectReviewComment(comment, index) {
  const label = `review comment ${index + 1}`;
  if (!comment || typeof comment !== "object" || Array.isArray(comment))
    fail(`${label} is invalid`);
  if (!Number.isSafeInteger(comment.id) || comment.id < 1)
    fail(`${label} identity is invalid`);
  if (
    !FULL_SHA.test(comment.commit_id ?? "") ||
    !FULL_SHA.test(comment.original_commit_id ?? "")
  ) {
    fail(`${label} commit identity is invalid`);
  }
  const line = optionalLine(comment.line, `${label} line`);
  const originalLine = optionalLine(
    comment.original_line,
    `${label} original line`,
  );
  if (line === null && originalLine === null) fail(`${label} line is invalid`);
  return {
    id: comment.id,
    reviewId:
      comment.pull_request_review_id === null
        ? null
        : nonnegativeInteger(comment.pull_request_review_id, `${label} review`),
    author: authorIdentity(comment, label),
    inReplyToId:
      comment.in_reply_to_id === undefined
        ? null
        : nonnegativeInteger(comment.in_reply_to_id, `${label} reply`),
    path: repositoryPath(comment.path, `${label} path`),
    line,
    originalLine,
    side:
      comment.side === "LEFT" || comment.side === "RIGHT" ? comment.side : null,
    commitSha: comment.commit_id,
    originalCommitSha: comment.original_commit_id,
    createdAt: timestamp(comment.created_at, label),
    body: bodyText(comment.body, label),
  };
}

function projectConversationComment(comment, index) {
  const label = `conversation comment ${index + 1}`;
  if (!comment || typeof comment !== "object" || Array.isArray(comment))
    fail(`${label} is invalid`);
  if (!Number.isSafeInteger(comment.id) || comment.id < 1)
    fail(`${label} identity is invalid`);
  return {
    id: comment.id,
    author: authorIdentity(comment, label),
    createdAt: timestamp(comment.created_at, label),
    body: bodyText(comment.body, label),
  };
}

function hasNextPage(headers) {
  return /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s*;|\s*(?:,|$))/u.test(
    headers?.get?.("link") ?? "",
  );
}

async function createPriorReviewContext({
  apiBase,
  owner,
  repository,
  pullNumber,
  token,
  fetchImpl,
  maxResponseBytes,
  maxBytes,
}) {
  const common = { per_page: 100, page: 1 };
  const [reviewsResult, commentsResult, conversationCommentsResult] =
    await Promise.all([
      optionalJson(
        requestUrl(
          apiBase,
          `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${pullNumber}/reviews`,
          common,
        ),
        token,
        fetchImpl,
        maxResponseBytes,
        "GitHub prior reviews",
      ),
      optionalJson(
        requestUrl(
          apiBase,
          `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${pullNumber}/comments`,
          common,
        ),
        token,
        fetchImpl,
        maxResponseBytes,
        "GitHub prior review comments",
      ),
      optionalJson(
        requestUrl(
          apiBase,
          `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${pullNumber}/comments`,
          common,
        ),
        token,
        fetchImpl,
        maxResponseBytes,
        "GitHub prior pull request conversation comments",
      ),
    ]);
  const error =
    reviewsResult.error ??
    commentsResult.error ??
    conversationCommentsResult.error;
  if (error)
    return nestedIncomplete(error, {
      reviews: [],
      comments: [],
      conversationComments: [],
    });
  if (
    hasNextPage(reviewsResult.headers) ||
    hasNextPage(commentsResult.headers) ||
    hasNextPage(conversationCommentsResult.headers)
  )
    return nestedIncomplete("prior review history requires pagination", {
      reviews: [],
      comments: [],
      conversationComments: [],
    });
  if (
    !Array.isArray(reviewsResult.value) ||
    !Array.isArray(commentsResult.value) ||
    !Array.isArray(conversationCommentsResult.value)
  )
    return nestedIncomplete("GitHub prior review history is invalid", {
      reviews: [],
      comments: [],
      conversationComments: [],
    });
  try {
    const publishedReviews = reviewsResult.value.filter(
      (review) => review?.state !== "PENDING",
    );
    const publishedReviewIds = new Set(
      publishedReviews.map((review) => review?.id),
    );
    const memory = {
      complete: true,
      reviews: publishedReviews.map(projectReview),
      comments: commentsResult.value
        .filter((comment) =>
          publishedReviewIds.has(comment?.pull_request_review_id),
        )
        .map(projectReviewComment),
      conversationComments: conversationCommentsResult.value.map(
        projectConversationComment,
      ),
    };
    return serializedBytes(memory) > maxBytes
      ? nestedIncomplete(
          `prior review history exceeds the ${maxBytes}-byte budget`,
          {
            reviews: [],
            comments: [],
            conversationComments: [],
          },
        )
      : Object.freeze(memory);
  } catch {
    return nestedIncomplete("GitHub prior review history is invalid", {
      reviews: [],
      comments: [],
      conversationComments: [],
    });
  }
}

export async function createReviewContext({
  event,
  expectedRepository,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  maxFiles = MAX_FILES,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  maxSnapshotBytes = MAX_SNAPSHOT_BYTES,
  maxRepositoryContextFiles = MAX_REPOSITORY_CONTEXT_FILES,
  maxRepositoryContextBytes = MAX_REPOSITORY_CONTEXT_BYTES,
  maxPriorReviewBytes = MAX_PRIOR_REVIEW_BYTES,
  maxAggregateBytes = MAX_AGGREGATE_BYTES,
} = {}) {
  const metadata = metadataFromEvent(event, expectedRepository);
  if (typeof token !== "string" || token.length < 1 || token.length > 4096)
    fail("GitHub token is unavailable");
  let apiBase;
  try {
    apiBase = new URL(apiUrl);
  } catch {
    fail("GitHub API URL is invalid");
  }
  if (
    apiBase.protocol !== "https:" ||
    apiBase.username ||
    apiBase.password ||
    apiBase.search ||
    apiBase.hash
  ) {
    fail("GitHub API URL is invalid");
  }
  if (metadata.changedFiles > maxFiles) {
    return incomplete(
      metadata,
      `comparison exceeds the ${maxFiles}-file review budget`,
    );
  }
  const [owner, repository] = metadata.repository.split("/");
  apiBase.pathname = `${apiBase.pathname.replace(/\/$/, "")}/`;
  let rawFiles = [];
  if (metadata.changedFiles > 0) {
    const url = requestUrl(
      apiBase,
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/compare/${metadata.baseSha}...${metadata.headSha}`,
      { per_page: 1, page: 1 },
    );
    const response = await fetchImpl(url, requestOptions(token));
    if (!response || response.status !== 200)
      fail("GitHub changed-file request failed");
    const responseText = await boundedResponseText(response, maxResponseBytes);
    if (responseText === null)
      return incomplete(metadata, "GitHub comparison response is too large");
    let comparison;
    try {
      comparison = JSON.parse(responseText);
    } catch {
      fail("GitHub changed-file response is invalid");
    }
    rawFiles = comparison?.files;
  }
  if (!Array.isArray(rawFiles) || rawFiles.length !== metadata.changedFiles)
    return incomplete(metadata, "GitHub changed-file response is incomplete");
  const files = rawFiles.map(projectFile);
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  if (files.some((file) => !hasCompletePatch(file, filesByPath)))
    return incomplete(
      metadata,
      "GitHub comparison omits a complete changed-file patch",
    );
  const comparisonSnapshot = {
    schemaVersion: 2,
    complete: true,
    repository: metadata.repository,
    pullNumber: metadata.pullNumber,
    baseSha: metadata.baseSha,
    headSha: metadata.headSha,
    files,
  };
  if (serializedBytes(comparisonSnapshot) > maxSnapshotBytes)
    return incomplete(
      metadata,
      `comparison exceeds the ${maxSnapshotBytes}-byte review budget`,
    );
  const [repositoryContext, priorReviewContext] = await Promise.all([
    createRepositoryContext({
      apiBase,
      owner,
      repository,
      token,
      rawFiles,
      files,
      fetchImpl,
      maxResponseBytes,
      maxFiles: maxRepositoryContextFiles,
      maxBytes: maxRepositoryContextBytes,
      headSha: metadata.headSha,
    }),
    createPriorReviewContext({
      apiBase,
      owner,
      repository,
      pullNumber: metadata.pullNumber,
      token,
      fetchImpl,
      maxResponseBytes,
      maxBytes: maxPriorReviewBytes,
    }),
  ]);
  const snapshot = {
    ...comparisonSnapshot,
    repositoryContext,
    priorReviewContext,
  };
  if (serializedBytes(snapshot) > maxAggregateBytes) {
    snapshot.priorReviewContext = nestedIncomplete(
      `combined context exceeds the ${maxAggregateBytes}-byte budget`,
      { reviews: [], comments: [], conversationComments: [] },
    );
  }
  if (serializedBytes(snapshot) > maxAggregateBytes) {
    snapshot.repositoryContext = nestedIncomplete(
      `combined context exceeds the ${maxAggregateBytes}-byte budget`,
      { refSha: metadata.headSha, files: [] },
    );
  }
  if (serializedBytes(snapshot) > maxAggregateBytes)
    return incomplete(
      metadata,
      `comparison exceeds the ${maxAggregateBytes}-byte aggregate budget`,
    );
  return Object.freeze(snapshot);
}

export async function runPrepareReviewContextAction({
  env = process.env,
  statImpl = stat,
  readFileImpl = readFile,
  appendFileImpl = appendFile,
  fetchImpl = fetch,
} = {}) {
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_OUTPUT)
    fail("GitHub event and output paths are required");
  const eventMetadata = await statImpl(env.GITHUB_EVENT_PATH);
  if (!eventMetadata.isFile() || eventMetadata.size > MAX_EVENT_BYTES)
    fail("GitHub event is invalid");
  const event = JSON.parse(await readFileImpl(env.GITHUB_EVENT_PATH, "utf8"));
  const snapshot = await createReviewContext({
    event,
    expectedRepository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL,
    fetchImpl,
  });
  if (!snapshot.complete) fail(snapshot.reason);
  await appendFileImpl(
    env.GITHUB_OUTPUT,
    `snapshot=${serializePromptSnapshot(snapshot)}\n`,
    "utf8",
  );
  return snapshot;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPrepareReviewContextAction().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  });
}
