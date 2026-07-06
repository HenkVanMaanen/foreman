#!/usr/bin/env bash
# keeper.sh — the dumb outer keeper.
#
# This is the ONE piece the agent must never edit. Its only job is to respawn the
# harness if it ever exits — so that when the foreman agent modifies its own harness
# and introduces a bug, the process just bounces and comes back. Durable state lives
# in notes/ and in detached worker processes, so a bounce loses nothing.
#
# Keep this file trivial. For production, prefer systemd/pm2 with the same semantics.
set -u

cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a

backoff=1
while true; do
  echo "[keeper] starting harness $(date -u +%FT%TZ)"
  bun run src/foreman.ts supervise
  code=$?
  echo "[keeper] harness exited with code $code; respawning in ${backoff}s"
  sleep "$backoff"
  # exponential backoff capped at 30s, so a crash-loop doesn't hammer the machine
  backoff=$(( backoff < 30 ? backoff * 2 : 30 ))
done
