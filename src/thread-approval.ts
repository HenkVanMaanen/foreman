// The supervisor alone grants authority. Worker helpers check its exact scope and run the gate.
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { HumanPost } from "./mattermost.ts";
import { readJson, safeId, writeJson } from "./thread-store.ts";

export interface ApprovalRequest {
  source: string;
  target: string;
  head: string;
  actions: ("merge" | "undraft")[];
}

export interface ApprovalGrant {
  id: string;
  source: HumanPost;
  at: string;
  receipts: string[];
  delivered?: boolean;
}

export interface Approval {
  id: string;
  thread: string;
  repo: string;
  cwd: string;
  request: ApprovalRequest;
  source: HumanPost;
  at: string;
  grants?: ApprovalGrant[];
  resolution?: { outcome: "completed" | "declined"; note: string; at: string; actor?: "worker" };
  delivered?: boolean;
}

interface Review {
  grant: string;
  head: string;
  startedAt: string;
  finishedAt?: string;
  clean: boolean;
}

export function approvalReceipts(state: string, approval: Approval): string[] {
  const dir = join(state, "thread-inbox");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson<HumanPost | null>(join(dir, file), null))
    .filter(
      (post): post is HumanPost =>
        post?.channel === approval.source.channel && post?.root === approval.source.root,
    )
    .map((post) => post.id)
    .sort();
}

export function currentApprovalGrant(state: string, approval: Approval): ApprovalGrant | undefined {
  const grant = approval.grants?.at(-1);
  if (
    approval.resolution ||
    !grant ||
    JSON.stringify(grant.receipts) !== JSON.stringify(approvalReceipts(state, approval))
  )
    return undefined;
  return grant;
}

export function approvalArtifact(
  state: string,
  approval: Approval,
  grant: ApprovalGrant,
  kind: "review" | "result",
): string {
  return join(
    state,
    "thread-approval-work",
    safeId(approval.thread),
    `${safeId(approval.id)}-${safeId(grant.id)}.${kind}.json`,
  );
}

export function workerApproval(
  state: string,
  key: string,
  id: string,
  cwd: string,
): { approval: Approval; grant: ApprovalGrant } {
  const registry = readJson<{ approvals?: Approval[] }>(join(state, "threads/registry.json"), {});
  const approval = registry.approvals?.find((item) => item.id === id && item.thread === key);
  if (!approval || realpathSync(approval.cwd) !== realpathSync(cwd))
    throw new Error("approval is not bound to this thread and worktree");
  const grant = currentApprovalGrant(state, approval);
  if (!grant)
    throw new Error(
      "current resident-verified task grant required; new human messages suspend old grants",
    );
  if (readJson(approvalArtifact(state, approval, grant, "result"), null) !== null)
    throw new Error("task completion already reported; this grant cannot be reused");
  return { approval, grant };
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("approval git scope check failed");
  return result.stdout.toString().trim();
}

function checkedHead(approval: Approval): string {
  if (git(approval.cwd, ["status", "--porcelain", "--untracked-files=no"]))
    throw new Error("commit tracked review changes before checking the gate");
  const head = git(approval.cwd, ["rev-parse", "HEAD"]);
  git(approval.cwd, ["merge-base", "--is-ancestor", approval.request.head, head]);
  return head;
}

export function cleanApprovalReview(
  state: string,
  approval: Approval,
  grant: ApprovalGrant,
  head: string,
): boolean {
  const review = readJson<Review | null>(approvalArtifact(state, approval, grant, "review"), null);
  return (
    review?.clean === true &&
    review.grant === grant.id &&
    review.head === head &&
    typeof review.startedAt === "string" &&
    review.startedAt >= grant.at &&
    typeof review.finishedAt === "string" &&
    review.finishedAt >= review.startedAt
  );
}

export async function reviewApproval(
  state: string,
  key: string,
  id: string,
  cwd: string,
): Promise<string> {
  const { approval, grant } = workerApproval(state, key, id, cwd);
  const head = checkedHead(approval);
  if (cleanApprovalReview(state, approval, grant, head)) return head; // Replay need not rerun an unchanged CLEAN gate.
  const path = approvalArtifact(state, approval, grant, "review");
  const review: Review = {
    grant: grant.id,
    head,
    startedAt: new Date().toISOString(),
    clean: false,
  };
  writeJson(path, review); // An interrupted or failed rerun invalidates any earlier CLEAN result.
  const child = Bun.spawn(
    [
      "flock",
      "-n",
      "-E",
      "75",
      "-F",
      join(state, "threads", `${safeId(key)}.review.lock`),
      "review-loop",
      "--dir",
      approval.cwd,
    ],
    {
      cwd: approval.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  let tail = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    process.stdout.write(chunk);
    tail = (tail + decoder.decode(chunk, { stream: true })).slice(-8192);
  }
  tail += decoder.decode();
  const code = await child.exited;
  // Exit 0 alone is insufficient (for example a skipped run or an echoed CLEAN in earlier output).
  if (code !== 0 || !/^review-loop: CLEAN — .+$/.test(tail.trim().split("\n").at(-1) ?? ""))
    throw new Error("final review did not finish CLEAN; merge remains unavailable");
  const current = workerApproval(state, key, id, cwd);
  if (current.grant.id !== grant.id) throw new Error("task grant changed during review");
  review.head = checkedHead(approval);
  review.finishedAt = new Date().toISOString();
  review.clean = true;
  writeJson(path, review);
  return review.head;
}

export function checkApproval(
  state: string,
  key: string,
  id: string,
  cwd: string,
  target: string,
  head: string,
  action: string,
): Approval {
  const { approval, grant } = workerApproval(state, key, id, cwd);
  if (
    target !== approval.request.target ||
    !approval.request.actions.some((allowed) => allowed === action)
  )
    throw new Error("action or PR URL is outside this task grant");
  if (checkedHead(approval) !== head || !cleanApprovalReview(state, approval, grant, head))
    throw new Error("a CLEAN final review for this exact head and task grant is required");
  return approval;
}

export function finishApproval(
  state: string,
  key: string,
  id: string,
  cwd: string,
  head: string,
  note: string,
): void {
  const { approval, grant } = workerApproval(state, key, id, cwd);
  if (!note.trim() || !cleanApprovalReview(state, approval, grant, head))
    throw new Error("completion needs the reviewed head and an actual action result");
  // A result is telemetry, not a grant. The supervisor consumes the resident's grant on adoption.
  writeJson(approvalArtifact(state, approval, grant, "result"), {
    head,
    note,
    at: new Date().toISOString(),
  });
}

export function approvalRequest(value: unknown): ApprovalRequest {
  if (!value || typeof value !== "object") throw new Error("approval request required");
  const { source, target, head, actions } = value as ApprovalRequest;
  if (typeof source !== "string" || !/^mm:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(source))
    throw new Error("approval source must be an original mm:channel:post reference");
  if (
    typeof target !== "string" ||
    !/^https:\/\/[^\s]+\/(?:pull|merge_requests)\/\d+$/.test(target)
  )
    throw new Error("approval target must be an exact HTTPS PR/MR URL");
  if (typeof head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))
    throw new Error("approval head must be a full commit hash");
  if (
    !Array.isArray(actions) ||
    !actions.length ||
    actions.some((action) => action !== "merge" && action !== "undraft")
  )
    throw new Error("approval actions must be merge and/or undraft");
  return { source, target, head, actions: [...new Set(actions)].sort() };
}

export function approvalId(key: string, request: ApprovalRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([safeId(key), request]))
    .digest("hex");
}

export function enqueueApproval(state: string, key: string, value: unknown): string {
  const request = approvalRequest(value);
  const id = approvalId(key, request);
  const dir = join(state, "thread-approvals", safeId(key));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.json`);
  const temp = `${path}.${process.pid}.publish`;
  writeJson(temp, request);
  try {
    linkSync(temp, path); // Immutable publication; replay cannot replace a request or its result.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temp);
  }
  return id;
}
