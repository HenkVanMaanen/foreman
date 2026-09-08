Update the existing Simulation draft MR !447 in the current worktree per Henk feedback msg 333051195.

The existing `standaard-radar-go` HelmRelease must serve ONLY `radar.simulatie.datastelsel.nl`; remove
`radar-go.simulatie.datastelsel.nl` from its `httpRoute.hostnames`. Keep the Rust route disabled and preserve all
workloads, Services, databases, PVCs, and canonical suspension. Adjust comments and MR description so they no
longer claim both hostnames remain. Keep the diff minimal.

Re-run relevant render assertions, manifest validation, required lint, and verify exactly one active owner for the
canonical hostname and zero rendered routes for the temporary Go hostname. Commit/push to the existing branch,
update draft MR !447, observe exact-head pipeline, and update
`/home/dev/foreman/notes/tasks/radar-canonical-route-recovery.md`. No review-loop, merge, or live mutation.
