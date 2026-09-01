Read-only diagnosis of qrlink preview auth failure on review host 95.217.34.151. User explicitly said we have access to the review server. SSH key: /home/dev/.ssh/preview_key. Determine the correct SSH user safely from existing ssh config/history or try normal non-destructive candidates; never print private key material.

Context: preview id/host prefix is 507d162c. Run 2918 deploy-preview is green. E2E login completes at Zitadel and oauth2-proxy session is valid (`/oauth2/auth` 202, `/oauth2/userinfo` 200 with user/email), but dashboard lands `/error` and `/api/self` returns API 401 twice. `/api/livez` and `/api/readyz` are 200. Repo code worker is tracing logic separately.

Task:
1. Read qrlink repo AGENTS.md/CLAUDE.md plus relevant server/preview scripts if needed.
2. SSH read-only. Identify only containers/services for preview 507d162c. Inspect recent API, oauth2-proxy, Zitadel, Traefik logs/config metadata sufficient to determine why the valid proxy session produces API 401. Redact tokens/cookies/secrets; never output raw env values.
3. Compare timestamps 2026-08-25 13:41:50–13:43:02 UTC and current live probes. Look for exact validator/issuer/audience/header/userinfo errors. Inspect container health and non-secret config names/hostnames only.
4. Do not restart/recreate/edit/delete containers, files, DNS, services, branches, PRs, or deployment state. No code changes. Do not open PR.
5. Write /home/dev/foreman/notes/tasks/qrlink-preview-auth-logs.md and state result JSON with exact evidence and recommended fix location.
