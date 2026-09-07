Fresh-context implementation task in /home/dev/foreman. Henk says GPT-6 xhigh is available in online ChatGPT and
asks us to update Codex, because installed Codex CLI 0.144.6 rejected gpt-6. Use the official Codex manual workflow
first (run /home/dev/.codex/skills/.system/openai-docs/scripts/fetch-codex-manual.mjs and inspect relevant install,
update, and model-config sections). Determine how this CLI was installed and the newest official version available.
Safely update it using its official installation channel; do not touch keeper.sh. Then refresh/check the authenticated
model catalog and run an ephemeral exact probe for the actual GPT-6 coding model slug with
model_reasoning_effort=xhigh. Do not guess a slug or claim success without a real response. If successful, implement
the smallest durable defaults for the resident foreman Codex command, detached spawn-worker invocations, and every
review-loop Codex invocation; validate shell syntax and TypeScript/Biome/typecheck as applicable. Document any
restart requirement but do not modify keeper.sh. If still unavailable after update, leave current gpt-5.6-sol
defaults unchanged and record the exact verified blocker. Update notes/tasks/foreman-gpt6-xhigh.md with versions,
evidence, files, tests, and rollback. Write state/foreman-codex-upgrade-gpt6.result.json. No push/harness-sync;
orchestrator owns publication.
