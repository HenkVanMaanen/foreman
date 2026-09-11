#!/usr/bin/env bash
set -euo pipefail
exec bun run "${FOREMAN_HOME:?FOREMAN_HOME required}/src/agent-context-cli.ts" bounded-run "$@"
