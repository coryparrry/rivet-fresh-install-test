import { appendFile, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9-]+(?:\[bot\])?$/i;
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MARKER_PREFIX = "<!-- rivet-triage-state:v1 ";
const MARKER_SUFFIX = " -->";
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_COMMENTS = 100;
const MAX_MISSING_ITEMS = 8;
const MAX_MISSING_ITEM_BYTES = 512;

function fail(message) {
  throw new Error(`Rivet issue context: ${message}`);
}

function ineligible(message) {
  const error = new Error(`Rivet issue context: ${message}`);
  error.code = "RIVET_ISSUE_CONTEXT_INELIGIBLE";
  throw error;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${name} is invalid`);
  return value;
}

function login(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    !LOGIN.test(value)
  ) {
    fail(`${name} is invalid`);
  }
  return value;
}

function text(value, name, maximumBytes, { nullable = false } = {}) {
  if (nullable && value === null) return "";
  if (typeof value !== "string" || Buffer.byteLength(value) > maximumBytes)
    fail(`${name} is invalid or exceeds its byte budget`);
  return value;
}

function timestamp(value, name) {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(`${name} is invalid`);
  }
  return value;
}

function association(value, name) {
  if (typeof value !== "string" || !/^[A-Z_]{1,32}$/.test(value))
    fail(`${name} is invalid`);
  return value;
}

function markerState(body) {
  if (typeof body !== "string") return null;
  const start = body.lastIndexOf(MARKER_PREFIX);
  if (start < 0) return null;
  const valueStart = start + MARKER_PREFIX.length;
  const end = body.indexOf(MARKER_SUFFIX, valueStart);
  if (end < 0 || body.slice(end + MARKER_SUFFIX.length).trim() !== "")
    fail("App triage state marker is malformed");
  let state;
  try {
    state = JSON.parse(body.slice(valueStart, end));
  } catch {
    fail("App triage state marker is malformed");
  }
  if (
    !state ||
    Array.isArray(state) ||
    JSON.stringify(Object.keys(state).sort()) !==
      JSON.stringify(["missingInformation"]) ||
    !Array.isArray(state.missingInformation) ||
    state.missingInformation.length > MAX_MISSING_ITEMS
  ) {
    fail("App triage state marker is malformed");
  }
  for (const item of state.missingInformation) {
    if (
      typeof item !== "string" ||
      item.length < 1 ||
      item !== item.trim() ||
      /[\r\n]|<!--|--!?>/.test(item) ||
      Buffer.byteLength(item) > MAX_MISSING_ITEM_BYTES
    ) {
      fail("App triage state marker is malformed");
    }
  }
  return Object.freeze({
    missingInformation: Object.freeze([...state.missingInformation]),
  });
}

async function boundedJson(response, name) {
  if (!response || response.status !== 200) fail(`${name} request failed`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    fail(`${name} response exceeds its byte budget`);
  }
  if (!response.body?.getReader) fail(`${name} response body is unavailable`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail(`${name} response exceeds its byte budget`);
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    fail(`${name} response is invalid`);
  }
}

function apiBase(apiUrl) {
  let base;
  try {
    base = new URL(apiUrl);
  } catch {
    fail("GitHub API URL is invalid");
  }
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    fail("GitHub API URL is invalid");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
  return base;
}

async function getJson(url, token, fetchImpl, name) {
  return boundedJson(
    await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "rivet-issue-context",
        "x-github-api-version": "2022-11-28",
      },
    }),
    name,
  );
}

function eventMetadata(eventName, event, expectedRepository) {
  const repository = event?.repository?.full_name;
  if (!REPOSITORY.test(repository ?? "") || repository !== expectedRepository)
    fail("repository identity is invalid");
  const kind =
    eventName === "issues" && event?.action === "opened"
      ? "opened"
      : eventName === "issue_comment" && event?.action === "created"
        ? "followup"
        : null;
  if (!kind) fail("event is not eligible");
  if (event.issue?.pull_request)
    ineligible("pull request comments are not eligible");
  const issueNumber = positiveInteger(event.issue?.number, "issue number");
  const issueId = positiveInteger(event.issue?.id, "issue id");
  return Object.freeze({ repository, kind, issueNumber, issueId });
}

function projectIssue(issue, metadata) {
  if (
    !issue ||
    Array.isArray(issue) ||
    issue.pull_request ||
    issue.number !== metadata.issueNumber ||
    issue.id !== metadata.issueId ||
    issue.state !== "open"
  ) {
    fail("live issue identity is invalid");
  }
  const labels = issue.labels;
  if (!Array.isArray(labels) || labels.length > 32)
    fail("live issue labels are invalid");
  return Object.freeze({
    id: issue.id,
    number: issue.number,
    title: text(issue.title, "issue title", 1024),
    body: text(issue.body, "issue body", 16 * 1024, { nullable: true }),
    author: login(issue.user?.login, "issue author"),
    authorAssociation: association(
      issue.author_association,
      "issue author association",
    ),
    state: issue.state,
    url: text(issue.html_url, "issue URL", 1024),
    createdAt: timestamp(issue.created_at, "issue creation time"),
    updatedAt: timestamp(issue.updated_at, "issue update time"),
    labels: Object.freeze(
      labels.map((label, index) =>
        text(
          typeof label === "string" ? label : label?.name,
          `issue label ${index + 1}`,
          256,
        ),
      ),
    ),
  });
}

function projectComment(comment, index) {
  if (!comment || Array.isArray(comment))
    fail(`comment ${index + 1} is invalid`);
  const performedByApp = comment.performed_via_github_app;
  if (
    performedByApp !== null &&
    performedByApp !== undefined &&
    (typeof performedByApp !== "object" || Array.isArray(performedByApp))
  ) {
    fail(`comment ${index + 1} App identity is invalid`);
  }
  return Object.freeze({
    id: positiveInteger(comment.id, `comment ${index + 1} id`),
    body: text(comment.body, `comment ${index + 1} body`, 16 * 1024),
    author: login(comment.user?.login, `comment ${index + 1} author`),
    authorType: text(
      comment.user?.type,
      `comment ${index + 1} author type`,
      32,
    ),
    authorAssociation: association(
      comment.author_association,
      `comment ${index + 1} author association`,
    ),
    createdAt: timestamp(
      comment.created_at,
      `comment ${index + 1} creation time`,
    ),
    performedByApp: performedByApp !== null && performedByApp !== undefined,
  });
}

function sameLogin(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function serializePromptSnapshot(snapshot) {
  return JSON.stringify(snapshot).replaceAll("_" + "_GH_AW_", "\\u005f_GH_AW_");
}

export async function createIssueContext({
  eventName,
  event,
  expectedRepository,
  appBotLogin,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  maxSnapshotBytes = MAX_SNAPSHOT_BYTES,
} = {}) {
  const metadata = eventMetadata(eventName, event, expectedRepository);
  const configuredApp = login(
    `${login(appBotLogin, "configured App slug")}[bot]`,
    "configured App bot login",
  );
  if (typeof token !== "string" || token.length < 1 || token.length > 4096)
    fail("GitHub token is unavailable");
  const base = apiBase(apiUrl);
  const [owner, repository] = metadata.repository.split("/");
  const issuePath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${metadata.issueNumber}`;
  const issueUrl = new URL(issuePath, base);
  const liveIssue = await getJson(issueUrl, token, fetchImpl, "live issue");
  const issue = projectIssue(liveIssue, metadata);
  if (
    !sameLogin(
      issue.author,
      login(event.issue?.user?.login, "event issue author"),
    )
  ) {
    fail("live issue author identity changed");
  }
  if (!Number.isSafeInteger(liveIssue.comments) || liveIssue.comments < 0)
    fail("live issue comment count is invalid");
  if (liveIssue.comments > MAX_COMMENTS)
    fail(`conversation exceeds the ${MAX_COMMENTS}-comment budget`);
  const commentsUrl = new URL(`${issuePath}/comments`, base);
  commentsUrl.searchParams.set("per_page", String(MAX_COMMENTS));
  commentsUrl.searchParams.set("page", "1");
  const rawComments = await getJson(
    commentsUrl,
    token,
    fetchImpl,
    "issue comments",
  );
  if (!Array.isArray(rawComments) || rawComments.length !== liveIssue.comments)
    fail("issue comments response is incomplete");
  const comments = rawComments.map(projectComment);
  const appMarkers = comments
    .map((comment, index) => ({
      comment,
      index,
      state:
        sameLogin(comment.author, configuredApp) &&
        comment.authorType === "Bot" &&
        comment.performedByApp
          ? markerState(comment.body)
          : null,
    }))
    .filter(({ state }) => state !== null);

  let snapshot;
  if (metadata.kind === "opened") {
    if (sameLogin(issue.author, configuredApp) || appMarkers.length > 0)
      ineligible("App-created or already-triaged issue is not eligible");
    snapshot = {
      schemaVersion: 1,
      complete: true,
      event: "opened",
      repository: metadata.repository,
      issue,
      previousTriage: null,
      previousMarkerCommentId: 0,
      conversation: [],
    };
  } else {
    const eventCommentId = positiveInteger(
      event.comment?.id,
      "event comment id",
    );
    const triggerIndex = comments.findIndex(
      (comment) => comment.id === eventCommentId,
    );
    if (triggerIndex < 0) fail("triggering comment is unavailable");
    const trigger = comments[triggerIndex];
    const eventAuthor = login(
      event.comment?.user?.login,
      "event comment author",
    );
    const sender = login(event.sender?.login, "event sender");
    if (
      !sameLogin(trigger.author, eventAuthor) ||
      !sameLogin(trigger.author, sender) ||
      event.comment?.body !== trigger.body ||
      event.comment?.author_association !== trigger.authorAssociation
    ) {
      fail("triggering comment identity changed");
    }
    if (
      trigger.authorType === "Bot" ||
      trigger.performedByApp ||
      event.sender?.type === "Bot" ||
      event.comment?.user?.type === "Bot"
    ) {
      ineligible("bot and App comments are not eligible");
    }
    if (
      !sameLogin(trigger.author, issue.author) &&
      !TRUSTED_ASSOCIATIONS.has(trigger.authorAssociation)
    ) {
      ineligible("comment author is not permitted to continue triage");
    }
    const previous = appMarkers
      .filter(({ index }) => index < triggerIndex)
      .at(-1);
    if (!previous || appMarkers.at(-1)?.comment.id !== previous.comment.id)
      ineligible("latest App triage state does not precede the trigger");
    if (previous.state.missingInformation.length === 0)
      ineligible("latest App triage state is not awaiting information");
    snapshot = {
      schemaVersion: 1,
      complete: true,
      event: "followup",
      repository: metadata.repository,
      issue,
      previousTriage: {
        commentId: previous.comment.id,
        missingInformation: previous.state.missingInformation,
      },
      previousMarkerCommentId: previous.comment.id,
      conversation: comments
        .slice(previous.index + 1, triggerIndex + 1)
        .map(({ id, body, author, authorAssociation, createdAt }) => ({
          id,
          body,
          author,
          authorAssociation,
          createdAt,
        })),
    };
  }
  if (Buffer.byteLength(serializePromptSnapshot(snapshot)) > maxSnapshotBytes)
    fail(`snapshot exceeds the ${maxSnapshotBytes}-byte budget`);
  return Object.freeze(snapshot);
}

export async function runPrepareIssueContextAction({
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
  let event;
  try {
    event = JSON.parse(await readFileImpl(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    fail("GitHub event is invalid");
  }
  let snapshot;
  try {
    snapshot = await createIssueContext({
      eventName: env.GITHUB_EVENT_NAME,
      event,
      expectedRepository: env.GITHUB_REPOSITORY,
      appBotLogin: env.RIVET_APP_BOT_LOGIN,
      token: env.GITHUB_TOKEN,
      apiUrl: env.GITHUB_API_URL,
      fetchImpl,
    });
  } catch (error) {
    if (error?.code !== "RIVET_ISSUE_CONTEXT_INELIGIBLE") throw error;
    await appendFileImpl(env.GITHUB_OUTPUT, "eligible=false\n", "utf8");
    return Object.freeze({ eligible: false, reason: error.message });
  }
  await appendFileImpl(
    env.GITHUB_OUTPUT,
    `eligible=true\nsnapshot=${serializePromptSnapshot(snapshot)}\n`,
    "utf8",
  );
  return Object.freeze({ eligible: true, snapshot });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPrepareIssueContextAction().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  });
}
