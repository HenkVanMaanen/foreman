# Codex quota in the Mattermost bot status

The bot's custom status contains the plain text `Codex 5h 82% · 7d 64% left`.
The emoji field is explicitly empty, so refreshing also removes an older battery
icon. Mattermost displays the text in the bot's profile; its chat-header custom
status slot shows only an emoji and stays empty with this setting.
Percentages are remaining main Codex quota, rounded down. Spark is excluded.
Window labels follow the returned durations; missing windows are omitted and an
unavailable reading displays `Codex ?`.

With thread agents and Mattermost configured, status updates default to enabled.
The sole supervisor reads quota on its first router tick and every five minutes,
including while idle and without a bound quota-alert thread. Set
`FOREMAN_CODEX_QUOTA_STATUS=0` to disable. Telegram emergency mode pauses updates.

The existing finite app-server query supplies both status and optional
[5% alerts](codex-quota-alert.md). Due checks share one read; alert polling keeps
its own configured interval. No model turn or additional inbox poller is started.
Status failures retry on the next five-minute check and do not suppress alerts.

Updates use Mattermost's [custom status API](https://github.com/mattermost/mattermost/blob/master/api/v4/source/status.yaml)
with a six-minute expiry: five minutes plus grace for the next query and HTTP
request. If the supervisor stops or delivery fails, the last percentages expire.
Mattermost must have custom user statuses enabled. This replaces the bot's
existing custom status.

After the approved merge, the resident installs the merged revision through the
guarded runtime rollout, retaining existing Codex authentication, Mattermost
credentials, `FOREMAN_THREAD_AGENTS=1`, and the durable state directory. Keep
`FOREMAN_CODEX_QUOTA_STATUS=1` (the default). Verify the bot's `props.customStatus`
on `/api/v4/users/me`: main quota appears after the first tick and `expires_at`
advances again about five minutes later. Confirm `emoji` is empty and the profile
shows the quota text. No worker-side runtime launch is needed.

Local checks: `bun test test/codex-quota-status.test.ts test/codex-quota.test.ts`,
`bun run check`, and the normal `bun run test` pipeline. Quota and Mattermost
transports are mocked; live status verification belongs to the resident rollout.
