# foreman notes — INDEX

This file is your always-loaded table of contents. Keep it short; link out to detail files.
On every launch you read this first. **If this file still looks like the template below,
you have not been onboarded — page a human and ask what to work on (see the bootstrap prompt).**

## Operating config
- Concurrency cap: _unset_ (record a safe max number of parallel `claude -p` workers here)
- Channels available: _unset_ (telegram? mattermost?)

## Task sources
_none yet — ask a human where your work comes from (tracker, repos, labels)._

## Repos & autonomy rules
_none yet — record one line per repo, e.g._
- `acme/api` — MRs only, never push main; require human to merge.

## Credentials (names only — values live in the encrypted store)
_none yet — e.g. `gitlab.acme.com → GITLAB_TOKEN`._

## Journals
- `journal/` — checkpoint entries written before a context recycle. Read the latest on launch.

## Scripts I own
- `bin/ask-human`, `bin/wait-reply` — human contact (see `examples/agent-bin/` for references).
