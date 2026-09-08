Diagnose read-only why https://radar.simulatie.datastelsel.nl returns "no healthy upstream" while
https://radar-go.simulatie.datastelsel.nl works after Simulation main 4a1cd690 was reconciled.

Use the live pinniped-datastelsel-simulatie Kubernetes context. If kubectl shim needs a version, invoke via
`mise exec asdf:kubectl@1.35.2 -- kubectl ...` (or locate the installed binary). Inspect HTTPRoutes and their
status/parents/backendRefs, Services, EndpointSlices/Endpoints, deployments/pods/readiness/restarts, events,
HelmRelease/OCIRepository/Flux conditions, and relevant logs. Compare canonical, Rust, and Go variants. Also
inspect the exact reconciled manifests in the Simulation repo as needed. Do not mutate the cluster or repositories.

Report exact evidence, root cause, blast radius, and the smallest safe remediation. Write the result to
`/home/dev/foreman/notes/tasks/radar-live-no-healthy-upstream.md` and finish promptly.
