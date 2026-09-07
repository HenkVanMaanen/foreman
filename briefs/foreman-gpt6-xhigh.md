You are a fresh-context implementation worker. Henk explicitly asks to switch GPT-6 with xhigh reasoning on for
everything, including the foreman runtime itself, detached workers, and every review pass. Work in
/home/dev/foreman. First inspect the harness/config/scripts and the locally installed Codex CLI capabilities to
determine the exact supported GPT-6 model identifier and reasoning setting; do not assume an alias. Do not touch
keeper.sh. Implement the smallest safe configuration changes needed across foreman, spawn-worker, and review-loop,
including durable defaults and rollback documentation. Validate shell syntax/tests and TypeScript typecheck if
src changes. Do not run harness-sync or otherwise push/merge; those require the orchestrator. Record a concise
result in notes/tasks/foreman-gpt6-xhigh.md, including changed files, validation, and anything requiring restart.
