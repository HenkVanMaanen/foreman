#!/usr/bin/env bash
# Resident: bind/ref/repo/worktree, dismiss/ref, retry/ref, policy-set/ref/repo/JSON.
# Everyone: policy-get/repo. Source refs are mm:channel:post from authorized inbox receipts.
set -euo pipefail
helper="${FOREMAN_HOME:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../..}/src/thread-cli.ts"
exec bun "$helper" "$@"
