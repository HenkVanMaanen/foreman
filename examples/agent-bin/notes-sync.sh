#!/usr/bin/env bash
# notes-sync — commit the agent's notes and push them to the foreman-state repo.
#
# The agent's memory (notes/INDEX.md, journal/, discovery/, tasks/) is durable state. Run
# this after any meaningful notes update and always as part of a checkpoint, so a crash or
# a context-recycle never loses memory and a fresh machine can resume by cloning the state.
#
# Usage: notes-sync ["commit message"]
# Env:   FOREMAN_NOTES_DIR (default: notes)  — the notes working tree (a clone of foreman-state)
set -euo pipefail

msg="${1:-notes update}"
dir="${FOREMAN_NOTES_DIR:-notes}"
cd "$dir"

if [ ! -d .git ]; then
  echo "notes-sync: $dir is not a git repo — set FOREMAN_STATE_REPO so the harness clones it" >&2
  exit 0
fi

git add -A
if git diff --cached --quiet; then
  echo "notes-sync: nothing to commit"
  exit 0
fi
git commit -q -m "$msg"
git branch -M main
git push -q -u origin main
echo "notes-sync: pushed notes to foreman-state (main)"
