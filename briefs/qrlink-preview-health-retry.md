Work in /home/dev/qrlink-server on existing branch fix/preview-analytics-readiness / draft PR #87.

Run 2925 deploy-preview failed twice because preview/scripts/health-check.sh probes the public API
/livez exactly once immediately after docker compose reports the API container healthy. Both attempts
got HTTP 404 at that instant, while the identical URL returned HTTP 200 seconds later. All other
services passed. This is a Traefik route-propagation race.

Implement a small, bounded readiness retry in the existing health-check script so transient non-ready
HTTP responses can recover, while persistent failures still fail clearly. Keep the total delay modest
and avoid hiding genuine failures. Audit whether the retry should apply uniformly to all services or
only API, choosing the clearest minimal design. Update/add the existing preview validation tests as
appropriate. Run relevant shell/static tests, git diff --check, commit, and push normally to the same
branch so draft PR #87 updates. Do not merge, un-draft, deploy to production, or run review-loop.

Report commit SHA, exact behavior/budget, tests, and any live-install steps foreman should perform.
