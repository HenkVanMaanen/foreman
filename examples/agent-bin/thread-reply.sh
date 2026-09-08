#!/usr/bin/env bash
# Text on stdin only. The supervisor alone chooses channel/root from the binding registry.
set -euo pipefail
[ "$#" = 0 ] || { echo 'thread-reply takes text on stdin, no destination arguments' >&2; exit 2; }
helper="${FOREMAN_HOME:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../..}/src/thread-cli.ts"
exec bun "$helper" outbox
