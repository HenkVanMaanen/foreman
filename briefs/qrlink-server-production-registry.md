# qrlink/server production registry alignment

Work only in `/home/dev/qrlink-server-registry` on branch `fix/production-registry-host`.

Context: qrlink app release 4.24.10 CI publishes all six application images to
`git.sallandpioneers.com/qrlink/<component>:4.24.10`. Production host `/root/qrl-server` uses this server repo,
but `docker-compose.yml` and the Makefile migration commands still reference
`registry.sallandpioneers.com/qrlink/...`; deploy therefore passes fingerprint/login/make and fails closed because
the expected image does not exist. Evidence is qrlink run 2935 deploy-prod job 25146.

Implement the smallest atomic fix: update all six production application image references and both API migration
references from the obsolete registry host to `git.sallandpioneers.com`, without changing third-party images,
versions, runtime behavior, or preview registry conventions unless evidence shows they share this exact production
contract. Add/update focused validation so production compose and Makefile cannot drift back to the old host and
all six current components are covered. Run server validation, Compose config, shell/diff checks as appropriate.

Commit, push, and open a **draft** Gitea PR. Do not run review-loop, undraft, merge, install/deploy remotely, or
touch qrlink app tags. Record exact files, validation, commit and PR URL in
`/home/dev/foreman/notes/tasks/qrlink-server-production-registry.md`. Return concise handoff.
