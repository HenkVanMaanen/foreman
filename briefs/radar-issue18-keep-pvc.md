# Radar issue 18: retain active PVC identity

Authoritative Henk decision: Telegram msg 333051182: "hmm maybe also dont rename the pvc so no migration / copy is needed".

Use fresh context and update the existing two draft MRs/worktrees:

- standaard-radar: `/home/dev/worktrees/radar-issue18`, branch `fix/issue18-cleanup`, MR !56.
- simulation: `/home/dev/worktrees/simulation-radar-issue18`, branch `chore/issue18-radar-deployments`, MR !443.

Current heads and design are documented in `/home/dev/foreman/notes/tasks/radar-issue18-canonical-names.md`.

Required outcome:

- Preserve the existing active Go PVC identity `standaard-radar-go-data`, just as the existing Database identity is preserved. No cache PVC migration or copy job should remain necessary.
- Keep all other requested application/chart/image/deployment identities canonical (without `go`), except the explicitly retained Database and PVC identities/references.
- Remove the now-unneeded temporary protect/cache/copy migration manifests, CI checks, docs/runbook steps, and MR-description claims relating to cache copying, while preserving any genuinely necessary safeguards.
- Configure the canonical Helm release/chart to mount the existing retained PVC explicitly and ensure it cannot be deleted or pruned during old-release removal/cutover. Analyze Helm ownership/release annotation conflicts carefully: a PVC created/owned by the old release must not be accidentally adopted, deleted, or rendered twice by the new release. Prefer an independently declared/prune-disabled retained PVC plus `persistence.existingClaim` if that is valid against live ownership; otherwise implement the safest minimal staged protection and explain it.
- Update stale-name sweeps so the retained PVC name is an intentional allowlisted exception, alongside the retained DB identities.
- Validate both repositories thoroughly but proportionately: relevant tests/lint, Helm packaging/render, Kustomize manifests, GitLab CI lint, and exact identity/ownership/pruning contracts. Do not run `bin/review-loop`.
- Commit and push updates to both existing draft branches, update/cross-link both MR descriptions, and leave both MRs draft. No merge, stable/manual publication, live Flux/Kubernetes/Helm changes, deletion, or rollout.
- Recheck exact-head pipelines after pushing. Report unrelated failures distinctly.
- Update `/home/dev/foreman/notes/tasks/radar-issue18-canonical-names.md` with final heads, validation, pipeline state, and revised rollout risks. Write a machine-readable result/status through the normal worker protocol.

Keep the change tightly scoped to Henk's decision. If retaining the current PVC still requires a live ownership-protection stage, implement/document that minimal stage; do not silently claim a no-op cutover without evidence.
