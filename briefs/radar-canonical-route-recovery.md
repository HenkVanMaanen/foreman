Work in the current fresh Simulation worktree from origin/main. Create a minimal recovery for the confirmed outage:
`radar.simulatie.datastelsel.nl` returns Envoy 503 from the legacy Rust route, while
`radar-go.simulatie.datastelsel.nl` reaches the already-running healthy Go release.

Implement a route-only GitOps recovery that makes the existing `standaard-radar-go` HelmRelease serve BOTH
`radar.simulatie.datastelsel.nl` and the existing `radar-go.simulatie.datastelsel.nl`, while removing/disabling the
canonical hostname from the legacy Rust route. Do not resume/install the suspended canonical release, do not create
a second workload, do not change databases/PVCs, and do not remove legacy releases/databases in this recovery.

Inspect both old chart templates and rendered manifests to prove exact HTTPRoute names, backend Service names,
ports, selectors, hostname ownership, and that both hostnames route to the existing Go Service. Preserve security
headers. Keep the diff minimal and follow AGENTS.md. Run manifest validation and required relevant lint. Commit,
push, and open a DRAFT MR with outage/recovery rationale, exact checks, and a note that canonicalization cleanup is
separate. Do not run review-loop, merge, or mutate the live cluster. Update
`/home/dev/foreman/notes/tasks/radar-canonical-route-recovery.md` with commit/MR/pipeline/checks and finish.
