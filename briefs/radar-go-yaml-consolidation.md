# Task: consolidate retained Radar resources into Go YAML on MR !447

Work in `/home/dev/worktrees/simulation-radar-route-recovery` on the existing branch
`fix/radar-canonical-route-recovery` and draft MR !447.

Authoritative feedback: Henk Telegram msg 333051197 asks to move the database stuff and related retained resources
to the Go YAML, while retaining the database naming so it continues to work without migration/copy.

Requirements:

1. Read repo instructions and the full current diff/MR context. Determine exactly which resources in the legacy
   Rust YAML must remain for the Go deployment and which can be consolidated into the Go YAML. Do not guess.
2. Move source YAML documents as requested while keeping the live Kubernetes object identity exact:
   apiVersion/kind/namespace/metadata.name, database name, PVC name, secret refs, service/selector/ports, and other
   persistence references must not change. The rendered kustomize object set must prove there is no delete/recreate,
   migration, or copy caused merely by the file move.
3. Keep the agreed route state: existing Go release serves only `radar.simulatie.datastelsel.nl`; no
   `radar-go.simulatie.datastelsel.nl` route; Rust route absent. Remove obsolete Rust YAML only if its remaining
   resources have been safely moved and no required legacy workload/resource is unintentionally deleted.
4. Add or update focused manifest/render assertions. Run manifest validation, applicable lint/Helm renders, and
   semantic before/after checks comparing object identities and persistence fields.
5. Commit and push to the existing branch/MR. Do not run review-loop, undraft, merge, or mutate the live cluster.
6. Wait for exact-head pipeline and fix failures attributable to the change. Confirm tested SHA equals MR head.
7. Update `/home/dev/foreman/notes/tasks/radar-canonical-route-recovery.md` with findings, exact before/after object
   identities, commit SHA, commands/results, pipeline URL/status, caveats, and why no data migration is needed.

Return a concise completion report. Keep changes tightly scoped to this feedback.
