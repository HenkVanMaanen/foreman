Work in /home/dev/qrlink on existing branch fix/687-qr-search-in-actions / draft PR #689. Read all AGENTS.md/CLAUDE.md fully.

Source task: Henk asked to fix all CI errors/deploy and approved merge when done. Live preview rollout with fail-closed server PR #87 exposed CMS container restart loop:
`Error: Cannot find module '/app/pnpm'`, Node v24.19.0. Container image `git.sallandpioneers.com/qrlink/cms:latest-pr-507d162c`, entrypoint docker-entrypoint.sh, cmd `["pnpm","run","start"]`.
Cause hypothesis is strong: cms/Dockerfile runs `corepack enable` only in build stage; runtime is a fresh `node:24-alpine` stage, copies /app only, and has CMD pnpm. Official Node entrypoint prepends `node` when command-v pnpm fails, producing `/app/pnpm` module error. The project now pins packageManager pnpm@10.33.0 from prior CI fix.

Task:
1. Confirm causality from Dockerfile/image behavior; inspect other project Dockerfiles for the established runtime pattern.
2. Implement the smallest robust CMS runtime fix on existing branch, normally enabling Corepack in runtime so pinned packageManager resolves pnpm. Do not use npm global floating install, shell hacks, or weaken health checks.
3. Add/update focused validation if feasible. Build the CMS image locally no-cache and run it far enough to prove `pnpm` resolves/the prior `/app/pnpm` crash is gone; use safe dummy env or command override and do not deploy live host.
4. Commit and push existing branch to update draft #689. Do not open a new PR, merge, un-draft, deploy, tag, or run review-loop.
5. Write /home/dev/foreman/notes/tasks/qrlink-cms-runtime-pnpm.md and state result JSON with cause, SHA, validation, and new CI run.

Preserve all existing PR changes and clean ancestry. No unrelated edits or secret output.
