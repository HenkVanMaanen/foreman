# Task: audit Foreman harness for Mattermost thread-to-agent routing

Read-only architecture audit. Henk wants Mattermost as primary ingress, Telegram emergency-only, and every new
Mattermost root post automatically interpreted by Codex and durably bound to its own parallel agent. Replies,
questions, status, and results must stay in that root thread. Thread agents may create branches/draft MRs under
repo-specific autonomy policy; policy changes stated by Henk must be durably persisted in foreman-state.

Inspect `/home/dev/foreman/src`, relevant `examples/agent-bin` scripts, current state formats, keeper boundaries,
tests, and package config. Do not edit anything, do not expose secrets, and do not contact external services.

Return a concise implementation design for the smallest safe first MR:

- current ingestion/execution lifecycle and whether any Mattermost support already exists;
- exact files/data structures to change;
- durable thread→agent/session/task mapping and lifecycle/restart semantics;
- concurrency/backpressure and per-thread message queuing;
- how same-thread replies are emitted without giving each agent raw bot credentials;
- durable autonomy-policy update path with human authorization/auditability;
- Telegram emergency-mode behavior and duplicate-ingress protection;
- tests and migration/backward compatibility;
- questions truly blocking implementation (DM vs channel and target username are already pending).

Do not propose a big rewrite. Prefer adapting the existing supervisor/inbox/reply mechanisms and Codex resumable
sessions. Write findings to `notes/tasks/mattermost-thread-agent-audit.md` and a result JSON.
