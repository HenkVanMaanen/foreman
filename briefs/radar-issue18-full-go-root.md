# Rewrite standaard-radar issue #18 drafts for final scope

Authoritative source: Henk Telegram msg `333051177`: Python and Rust may be removed entirely from the
standaard-radar repository, and everything under `go/` may move to the repository root.

Work primarily in `/home/dev/worktrees/radar-issue18` on existing branch `fix/issue18-cleanup` and draft MR !56.
The prior commit is `c81b1be2`. Inspect the entire repository and implement the full scope cleanly:

- Delete all Python and Rust implementation source, tooling, tests, configs, docs, CI references, and obsolete
  deployment material. Preserve only genuinely shared/repository metadata that belongs with the Go project.
- Move the complete Go project from `go/` to repository root, preserving history as sensible Git renames.
- Update every affected path/reference: CI, Docker/build contexts, Helm chart, README/docs, mise/tool config,
  generated assets, tests, scripts, ignore files, and any other repo-local references.
- Diagnose the failed prior exact-head `Lint (go)` job id `16343826111`; the rewritten layout must fix its actual
  cause rather than hiding it.
- Inspect companion `/home/dev/worktrees/simulation-radar-issue18` branch `chore/issue18-radar-deployments` and MR
  !443 read-only first. Modify it only if the new root layout changes published artifact/chart references required
  by deployment. If needed, validate, commit, and push narrowly on that existing branch.

Run proportionate full validation for the resulting sole Go repository: CI lint, generation, formatting/lint,
Go tests/vet, frontend/browser checks where feasible, Helm lint/render, Docker/build-context sanity, reference
sweeps, and `git diff --check`. Do not weaken tests or CI. Commit and push to existing draft MR(s); keep them draft.
Do not run `bin/review-loop`, merge, deploy, reconcile Flux, or alter DNS/TLS.

Update `/home/dev/foreman/notes/tasks/radar-issue18-cleanup.md` with exact changes, checks, commit SHA(s), pipeline
URL(s), and remaining operational caveats. Write the normal result JSON expected by `bin/spawn-worker` last.
