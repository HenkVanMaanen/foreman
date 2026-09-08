# Radar issue 18: remove rollout docs before approved merge

Authoritative Henk instruction: Telegram msg 333051183: "remove the rollout docs. and then merge both mr's".

This worker handles only the pre-merge content update. Foreman will run the final Codex-only review gates and merge afterward.

Existing worktrees/drafts:

- `/home/dev/worktrees/radar-issue18`, branch `fix/issue18-cleanup`, MR !56, current head `d42bcda1`.
- `/home/dev/worktrees/simulation-radar-issue18`, branch `chore/issue18-radar-deployments`, MR !443, current head `23bc4ee6`.

Required:

- Remove the rollout documentation added by this task, especially `docs/standaard-radar-canonical-rollout.md`, and remove all README/MR-description links or prose that presents a checked-in rollout/runbook.
- Sweep both branch diffs for any other added rollout-doc artifacts or stale claims about the removed cache-copy migration. Remove those docs/references too.
- Do not undo runtime safety in manifests: retained Database/PVC identities, `existingClaim`, suspend/fencing/ownership settings, and any concise manifest comments needed to understand configuration remain unless they are purely links to deleted docs.
- Keep MR descriptions accurate and concise after removing the rollout docs; cross-link the drafts and retain relevant validation/safety summary without a runbook link.
- Run proportionate quick validation in both repos (diff check, relevant render/manifest/Helm/docs reference sweep, GitLab CI lint if CI YAML changes). Do not run `bin/review-loop`.
- Commit and push all required updates to both existing branches. If one repo has no actual content change after the sweep, do not manufacture one; report its unchanged head.
- Leave both MRs draft for Foreman's final review gate. Do not merge, publish stable manually, or touch live infrastructure.
- Update `/home/dev/foreman/notes/tasks/radar-issue18-remove-rollout-docs.md` and write the normal machine-readable worker result.
