// Workers publish requests only. The supervisor validates receipts and owns their disposition.
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { safeId, writeJson } from "./thread-store.ts";

export interface ApprovalRequest {
  source: string;
  target: string;
  head: string;
  actions: ("merge" | "undraft")[];
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
