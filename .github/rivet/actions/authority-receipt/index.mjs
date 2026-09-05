import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
const WORKFLOW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createAuthorityReceipt({
  compilerVersion,
  workflowId,
  workflowRef,
  workflowSha,
}) {
  if (!VERSION.test(compilerVersion))
    throw new Error("Invalid compiler version");
  if (!WORKFLOW_ID.test(workflowId)) throw new Error("Invalid workflow id");
  if (!FULL_SHA.test(workflowSha)) throw new Error("Invalid workflow SHA");
  const marker = `/.github/workflows/${workflowId}.lock.yml@refs/heads/`;
  const markerIndex = workflowRef.indexOf(marker);
  const repository = workflowRef.slice(0, markerIndex);
  const branch = workflowRef.slice(markerIndex + marker.length);
  if (
    markerIndex < 0 ||
    !REPOSITORY.test(repository) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/")
  ) {
    throw new Error("Workflow ref must identify a base branch lock file");
  }
  return Object.freeze({
    schemaVersion: 1,
    workflowId,
    compilerVersion,
    workflowRef,
    workflowSha,
  });
}

export async function runAuthorityReceiptAction({
  env = process.env,
  appendFileImpl = appendFile,
} = {}) {
  if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  const receipt = createAuthorityReceipt({
    compilerVersion: env["INPUT_COMPILER-VERSION"] ?? "",
    workflowId: env["INPUT_WORKFLOW-ID"] ?? "",
    workflowRef: env["INPUT_WORKFLOW-REF"] ?? "",
    workflowSha: env["INPUT_WORKFLOW-SHA"] ?? "",
  });
  await appendFileImpl(
    env.GITHUB_OUTPUT,
    `receipt=${JSON.stringify(receipt)}\n`,
    "utf8",
  );
  return receipt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runAuthorityReceiptAction().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  });
}
