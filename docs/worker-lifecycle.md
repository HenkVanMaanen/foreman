# Worker launch and completion

`spawn-worker` records a durable launch intent, then waits up to five seconds for the
runner to acknowledge its actual PID and process identity. Runner startup errors go
to the worker log. No acknowledgement returns a failure to the caller; it does not
prove that a delayed runner cannot start. Pending launches become UNKNOWN after ten
seconds and wake a resident waiting on that name.

`FOREMAN_WORKER_LAUNCH` supports:

- `auto` (default): `nohup setsid` when setsid exists, otherwise `nohup`.
- `setsid`: require a new session; fail before launching if unavailable.
- `nohup`: retain the previous launch mechanism.
- `foreground`: keep the helper attached for the whole runner lifetime and return
  its exit code. An external service manager can own this process and its children.

A separate session protects against cleanup of the caller's process group. It does
not escape executor cgroup cleanup, machine shutdown, or arbitrary SIGKILL. No service
unit is created or changed by these helpers.

Each name identifies one run. Reusing a name with artifacts or registry history is
refused, including with `--force`, so old completion cannot be mistaken for a new run.
Use a fresh name; logs, results and registry history are retained. Both engines retain
their command lines, model selection, brief delivery, and result contract. Keep
`worker-state.sh` beside the other reference scripts when copying them manually;
normal workspace symlinks resolve to the bundled reference directory.

Status and the supervisor's existing parked wait use the same read-only probe:

- RUNNING means the runner's saved identity still matches a non-zombie process.
- STARTING means a recent launch is awaiting acknowledgement.
- ORPHANED means the runner is gone but its recorded engine child is still live.
- LOST means the runner is absent or its PID has been reused, without completion.
- UNKNOWN means liveness cannot be verified, including legacy live PIDs without a
  saved identity. `worker-stop` refuses to signal these unverified PIDs.
- DONE means the completion marker exists. The engine exit code and result still
  determine the outcome; DONE alone does not mean successful work.

A TERM interruption forwards to the engine child and waits for it before finalizing.
The wrapper preserves an engine-written result or atomically synthesizes
`needs-verify`, appends the exit record, and only then publishes `.done`. SIGKILL
cannot run a trap: LOST/ORPHANED/UNKNOWN also wake a parked resident without fabricating
a result or changing history. A missing wrapper releases capacity only when its
recorded engine child is also gone; absent child evidence reserves the slot. The
existing cap, weighted review-loop load and explicit `--force` override remain.

Sandbox error text may come from a successful command reading source documentation.
A missing result file is an omission, not proof that no commands ran. These signals
therefore never synthesize exit 86 or claim “executed nothing”: the engine exit is
retained, and a missing result requires verification. The helper does not claim to
classify actual tool execution from an unstructured transcript.

The reported repair-worker incident had an absent PID, an empty log and no completion.
That establishes vanished/no observed work; it does not establish a kill cause.
Process-group cleanup is a plausible failure mode, not a proven historical diagnosis.

Quick regressions: `bun test test/worker-lifecycle.test.ts` and
`env -i PATH=/usr/bin:/bin bash test/spawn-worker-engine.sh`. The launch fixtures use an
empty environment, a controlled PATH and disposable working directories so inherited
shell startup settings cannot bypass the CLI stubs.
