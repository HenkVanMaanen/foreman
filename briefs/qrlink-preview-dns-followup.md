# Follow-up: restore qrlink preview DNS and validate review host

Source: Henk msg 333051036 asked to fix preview infra in qrlink/server and explicitly said review-server access is available.

The first worker delivered draft server PR https://git.sallandpioneers.com/qrlink/server/pulls/86 (commit `8309910`) and report `/home/dev/foreman/notes/tasks/qrlink-preview-infra.md`. Read that report first.

Your task is the unresolved external half:
- Work primarily in `/home/dev/qrlink-dns` (clean `master`) and inspect `/home/dev/qrlink-server` plus `/home/dev/qrlink` read-only as needed.
- Prove why `pr.qrlink.dev` and `*.pr.qrlink.dev` are authoritative NXDOMAIN, find their intended DNS-as-code ownership/history and intended review-ingress target.
- Discover the review-server connection using existing config/credential references without printing raw secrets. Henk says access exists, so exhaust safe local config/repo/history/secret-name discovery before declaring it unavailable.
- If the DNS repo has a clear declarative fix, create branch `fix/preview-dns`, implement the smallest preview-only change, validate/plan it without applying it, commit as `Henk van Maanen <henk@qrlink.nl>`, push, and open a DRAFT PR. Do not mutate Cloudflare directly, merge, un-draft, or touch production records.
- If access is established, perform read-only review-host validation of Traefik ports/certificate/current `/opt/preview` scripts. Do not deploy PR #86 yet; report what deployment path would be needed.
- Do not edit `/home/dev/qrlink`: another worker owns active uncommitted changes.
- Never expose secret values, private keys, tokens, or sensitive environment contents in logs/report.

Run quick relevant validation. Write findings to `/home/dev/foreman/notes/tasks/qrlink-preview-dns-followup.md` and, as the last act, write the standard worker result JSON for task id `qrlink-preview-dns-followup`.
