Investigate Henk's report (msg 333051050): “qrlink pipelines failed.”

Primary repo: /home/dev/qrlink-deploy-move
Existing relevant draft PR: https://git.sallandpioneers.com/qrlink/qrlink/pulls/691
Branch: fix/production-deploy-host

Start read-only: use authenticated Gitea API/credentials already available through git credential helper to find
the newest qrlink workflow runs and exact failed jobs/logs, including PR #691. Provide direct run/job URLs and
distinguish deterministic branch failures from shared-runner/transient failures using log evidence and adjacent
runs. If a deterministic failure is caused by this branch, make the smallest correct fix in this existing
worktree/branch, test it proportionately, commit, push, and verify the remote head/new run. Preserve unrelated
changes. Do not open another PR, merge, tag, deploy, rerun expensive review-loop, or modify foreman notes. If the
failure belongs to a different qrlink branch, diagnose and report rather than editing the wrong branch.

Report exact failure cause(s), action taken, checks, commit if any, and URLs.
