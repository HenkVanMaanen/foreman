#!/usr/bin/env bash
# harness-sync — commit a harness self-improvement and push it to the foreman repo's main.
#
# When foreman improves its own harness (src/), run this to publish the change. A typecheck
# gate blocks pushing a harness that doesn't compile; the dumb keeper still protects the
# runtime from a bad-but-compiling change. keeper.sh is off-limits — never edit it.
#
# Usage: harness-sync ["commit message"]
# Env:   FOREMAN_HOME — the foreman repo checkout (must have an 'origin' remote with push)
set -euo pipefail

msg="${1:-harness: self-improvement}"
cd "${FOREMAN_HOME:?FOREMAN_HOME not set}"

if [ ! -d .git ]; then
  echo "harness-sync: FOREMAN_HOME ($PWD) is not a git checkout — clone the foreman repo to run from it" >&2
  exit 1
fi

# Gate: never push a harness that fails the strict check (Biome lint/format + tsc).
if [ -f package.json ] && grep -q '"check"' package.json; then
  echo "harness-sync: running strict check (biome + tsc)…"
  bun run check || { echo "harness-sync: check FAILED — not pushing" >&2; exit 1; }
fi

git add -A
if git diff --cached --quiet; then
  echo "harness-sync: nothing to commit"
  exit 0
fi
git commit -q -m "$msg"
git push -q origin HEAD:main
echo "harness-sync: pushed harness change to foreman main"
