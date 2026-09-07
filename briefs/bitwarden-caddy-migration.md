You are a fresh Codex implementation worker for SallandPioneers server-bitwarden.

Human request (Mattermost msg 333051114): switch Bitwarden/Vaultwarden from Nginx to Caddy; Caddy may use the
existing Cloudflare certificates; ensure Vaultwarden sees each user's real client IP.

Work only in `/home/dev/server-bitwarden-caddy` on branch `feat/caddy-reverse-proxy`, based on current
`origin/master`. Inspect the tiny repository completely before editing. Implement a minimal, production-sensible
migration:

- Replace the Nginx reverse-proxy service/config with Caddy and a tracked Caddyfile/config in the appropriate path.
- Reuse the repository/server's existing Cloudflare certificate and its corresponding untracked/deployed key by
  mounting certificate material read-only; never print or commit any private key or other secret.
- Preserve existing routes/websocket behavior and security headers where applicable.
- Configure the client-IP header/trusted-proxy chain correctly. Account for Cloudflare being the external proxy:
  accept Cloudflare's authenticated client IP only from Cloudflare source ranges, ensure Caddy passes the resolved
  real IP through standard proxy headers, and configure Vaultwarden's Rocket trusted-proxy setting if required by
  the pinned version. Do not blindly trust spoofable headers from arbitrary peers.
- Update Compose, Makefile/docs or examples only as required. Remove obsolete tracked Nginx configuration if fully
  replaced.
- Validate with `docker compose config` (or repo-appropriate equivalent), Caddy config validation if available,
  shell syntax checks, and focused static checks. If tooling is absent, use an ephemeral official Caddy container
  if safe and no secrets are needed.
- Commit the changes, push the branch, and open a DRAFT Gitea PR against master. Do not run review-loop and do not
  merge. Return the PR URL, head SHA, exact design for real-IP trust, validation results, and any deployment caveat.

Repository changes only. Do not deploy or access production.
