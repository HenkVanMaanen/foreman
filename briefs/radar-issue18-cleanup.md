Fresh-context multi-repo implementation for GitLab standaard-radar issue #18. Henk explicitly asks: remove every
deployed standaard-radar version from both the simulation repo and the standaard-radar repo, leaving only the Go
version, and change the Go deployment hostname to radar.simulation. Issue URL:
https://gitlab.com/datastelsel.nl/federatief/simulation/standaard-radar/-/work_items/18

Worktrees are /home/dev/worktrees/radar-issue18 (standaard-radar, branch fix/issue18-cleanup) and
/home/dev/worktrees/simulation-radar-issue18 (simulation, branch chore/issue18-radar-deployments). Read both repos'
AGENTS.md/instructions first. Inspect current deployments, CI, GitOps/Helm/compose/docs references and history so
you remove only deployed obsolete implementations, not useful source/history unless the issue truly requires it.
Keep the Go implementation/deployment, update its hostname consistently to radar.simulation, and preserve unrelated
services. Make small commits independently per repo, run proportionate tests/lint/config render validation, push
branches, and open draft MRs in both repos cross-linking issue #18 and each other. Do not run review-loop; human
iteration comes first. Do not merge/deploy/delete remote environments. Update
/home/dev/foreman/notes/tasks/radar-issue18-cleanup.md with root cause/scope, exact files, validation, commits, MRs,
and any migration or DNS caveat. Write /home/dev/foreman/state/radar-issue18-cleanup.result.json.
