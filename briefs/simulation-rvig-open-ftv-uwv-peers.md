Work in the current Simulation repository worktree. Henk requests a new, separate draft MR from current origin/main.

Find `fds-organization-rvig` HelmRelease `open-ftv` and append exact UWV ID `0000009903UWV0000000` to both:
- `spec.values.pdp.config.policyAttributes.fsc_ingress_peers` (subscriptions)
- `spec.values.pdp.config.policyAttributes.fsc_egress_peers` (callbacks)

Keep the change minimal and preserve list style/order conventions. Inspect repository instructions. Validate the
affected rendered manifest and run the relevant lightweight repository lint/tests (including full required lint if
practical). Commit, push the branch, and open a DRAFT GitLab MR with a concise description. Do not run review-loop,
do not merge, and do not change live infrastructure. Record result, commit, checks, pipeline and MR URL in
`/home/dev/foreman/notes/tasks/simulation-rvig-open-ftv-uwv-peers.md` and finish.
