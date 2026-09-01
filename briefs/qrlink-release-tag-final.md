Work in /home/dev/qrlink. This is a release verification task authorized by Henk msg 333051043.

Read-only until reporting back to foreman: fetch origin and tags, verify current origin/master includes
merged PR #689, identify the latest semantic version tag and exact next patch tag, and inspect the tag
workflow so the expected production actions are explicit. Confirm the candidate tag does not already
exist locally or remotely and report exact target SHA, tag name, annotated-vs-lightweight convention from
recent tags, and expected workflow URL discovery method. Do not create or push the tag yourself, do not
edit files, open PRs, merge, or trigger workflows. Foreman will perform the irreversible tag push after
checking your report.
