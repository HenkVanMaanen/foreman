#!/usr/bin/env bash
# Resident: bind/ref/repo/worktree, dismiss/ref, retry/ref, policy-set/ref/repo/JSON/--repo-wide,
# approval-list (compact unresolved), approval-read/id (full receipts), approval-grant/id/original-human-ref/JSON-receipts, approval-resolve/id/completed|declined/result-note.
# Thread worker: approval-request/ref/PR-URL/full-head-hash/JSON-actions;
# approval-review/id, approval-check/id/PR-URL/reviewed-head/action, approval-finish/id/reviewed-head/result-note.
# Workers request grants; only resident-verified grants authorize review and scoped actions.
# Everyone: policy-get/repo. Source refs are mm:channel:post from authorized inbox receipts.
set -euo pipefail
helper="${FOREMAN_HOME:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../..}/src/thread-cli.ts"
exec bun "$helper" "$@"
