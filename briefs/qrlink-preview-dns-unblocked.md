# Task: add preview DNS and validate review host (target supplied)

Source: Henk Telegram msg 333051038 supplied the review ingress target `95.217.34.151`, following msg 333051036 requesting preview-infra repair.

Work in `/home/dev/qrlink-dns` on the already-created branch `fix/preview-dns`. Read:
- `/home/dev/foreman/notes/tasks/qrlink-preview-dns-followup.md`
- `/home/dev/foreman/notes/tasks/qrlink-preview-infra.md`
- server draft PR branch `/home/dev/qrlink-server` (`fix/preview-infra`, PR #86)

Deliverables:
1. Determine the qrlink/dns repository’s zone/file conventions and add DNS-only A records for `pr.qrlink.dev` and `*.pr.qrlink.dev` targeting `95.217.34.151`. Do not guess proxy mode/TTL; follow comparable records and explain the choice. If the qrlink.dev zone truly does not exist, add it using the repo’s established structure only after verifying provider/source configuration supports it.
2. Run non-mutating validation and dry-run/plan. Never run Cloudflare sync/apply. If dry-run requires an existing secret by name, use the established secret wrapper without exposing values; if unavailable, record that limitation.
3. Perform read-only review-host validation using `/home/dev/.ssh/preview_key` against `root@95.217.34.151`: confirm auth, `/opt/preview`, Traefik host ports/listeners, wildcard certificate, and whether deployed scripts contain PR #86’s `--resolve` fix. Do not modify remote files/containers/services.
4. Commit DNS change as `Henk van Maanen <henk@qrlink.nl>`, push, and open a DRAFT PR against master. Do not merge, un-draft, deploy, or apply DNS.
5. Write `/home/dev/foreman/notes/tasks/qrlink-preview-dns-unblocked.md` with evidence, exact records/files, validation/plan output summary, read-only host state, commit/PR, and remaining sequence to restore preview. Write standard result JSON for task id `qrlink-preview-dns-unblocked` last.

Preserve unrelated work. Do not edit `/home/dev/qrlink` or `/home/dev/qrlink-server`. Do not run review-loop.
