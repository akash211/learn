# Process Management, Jobs and Signals

A script that starts a process takes on responsibility for it: waiting, limiting, cleaning up and
handling the signal that tells it to stop. Most production incidents in shell tooling come from
this chapter — orphaned children, `kill -9` on the wrong PID, cleanup that never runs.

## Two special numbers

```bash
$$    # PID of the current shell
$!    # PID of the last background command
$?    # status of the last foreground command
```

`$$` is stable for the life of the script, but inside a subshell `$$` is still the *parent* PID —
use `$BASHPID` (bash 4+) when you need the subshell's own PID. That distinction is the reason
"create a lock file with `$$`" behaves surprisingly inside `( ... )`.

## Background jobs

```bash
long_task > out.log 2>&1 &
pid=$!
wait "$pid"; rc=$?
```

`wait $pid` blocks and returns that child's status — the correct way to run things in parallel and
still check them.

```bash
for h in "${hosts[@]}"; do
  ssh "$h" 'uptime' > "out/$h.txt" 2>&1 &
done
wait                      # wait for all children
```

`wait` with no arguments waits for all background jobs and returns 0 regardless of their
individual statuses — it does **not** aggregate failures. If you need per-job failure, collect PIDs and `wait`
each one.

Job control (`jobs`, `fg`, `bg`, `%1`, `Ctrl-Z`) is an interactive feature. In a non-interactive
script, job control is off by default, so `jobs` shows nothing useful and `%1` does not exist.
`set -m` enables it, but scripts should use PIDs.

Detaching from the terminal:

| Tool | Effect |
|---|---|
| `cmd &` | Child of the shell; dies with SIGHUP if the terminal closes |
| `nohup cmd &` | Ignores SIGHUP, redirects output to `nohup.out` |
| `disown` | Removes the job from the shell's job table so HUP is not forwarded |
| `setsid cmd` | New session, no controlling terminal — the strongest detach |
| `systemd-run` / a unit | Proper supervision; the right answer for services |

For anything long-lived, use a supervisor (systemd, s6, supervisord), not `nohup`. `nohup` gives
you a process with no restart policy, no logging discipline and no way to stop it cleanly.

## Signals

Signals are asynchronous notifications delivered to a process. The ones scripts care about
(numbers are Linux/x86-64; they differ on other platforms):

| Signal | Number | Default | Typical source |
|---|---|---|---|
| SIGHUP | 1 | terminate | terminal closed, `kill -HUP` (also "reload" by convention) |
| SIGINT | 2 | terminate | Ctrl-C |
| SIGQUIT | 3 | core dump | Ctrl-\ |
| SIGKILL | 9 | terminate | `kill -9` — uncatchable, no cleanup |
| SIGTERM | 15 | terminate | `kill`, container stop, systemd |
| SIGSTOP | 19 | stop | uncatchable |
| SIGCHLD | 17 | ignore | child exited |
| SIGPIPE | 13 | terminate | write to a closed pipe |
| SIGUSR1/2 | 10/12 | terminate | application-defined |

Rules:

- **SIGTERM is the request; SIGKILL is the enforcement.** Send TERM, wait a bounded time, then
  KILL. `docker stop` and Kubernetes do exactly this with a 10 s / 30 s grace period.
- SIGKILL and SIGSTOP cannot be trapped. A process killed with `-9` leaves temp files, lock files
  and half-written output — your design must tolerate that (see the idempotency chapter).
- A handler should be short: set a flag, or clean up and exit. Doing real work inside a trap while
  the main flow continues leads to re-entrancy bugs.

```bash
trap 'echo "stopping" >&2; kill "$child" 2>/dev/null; exit 143' TERM INT
```

`exit 143` is 128 + 15, the conventional status for "terminated by SIGTERM". Shells report that
status automatically when a foreground command is killed, and CI systems read it.

## Traps and foreground commands

Bash runs a trap only **after the current foreground command finishes**. A script blocked in
`sleep 600` will not react to SIGTERM until the sleep ends — which is why containers appear to
ignore `docker stop`.

The fix is to background the long task and `wait` for it. `wait` is interruptible: a trapped signal
returns control immediately.

```bash
sleep 600 &
child=$!
wait "$child"
```

This is the standard "graceful shutdown" pattern for entrypoints: start the app in the background,
`wait`, and let the trap forward TERM and reap.

## Process inspection

```bash
ps -eo pid,ppid,stat,etime,rss,cmd --sort=-rss | head    # GNU
pgrep -af 'python.*worker'                                # by pattern, with args
pgrep -P "$pid"                                           # children of a PID
pkill -TERM -f 'worker.py'                                # pattern match, dangerous
ps -o pid,stat,wchan:25 -p "$pid"                         # state and wait channel
```

`ps aux | grep foo | grep -v grep` is the folklore version; `pgrep -af foo` is correct and does not
match itself. `pkill -f` matches the whole command line and will happily kill your editor if the
pattern is loose — prefer exact PIDs, or `pkill -x` on the process name.

Process states in `STAT`: `R` running, `S` sleeping, `D` uninterruptible sleep (usually I/O — a
process stuck in `D` cannot be killed until the I/O completes), `Z` zombie, `T` stopped.

A **zombie** is a child that has exited but whose parent has not called `wait`. It consumes a PID
slot only. It disappears when the parent reaps it or dies. You cannot kill a zombie; you fix the
parent.

An **orphan** is a process whose parent died; it is reparented to init (PID 1) or to a subreaper.
In containers, PID 1 must reap — a shell script as PID 1 that does not `wait` accumulates zombies,
which is why `dumb-init` and `tini` exist.

## Timeouts and limits

```bash
timeout 30 curl -fsS "$url" || echo "timed out or failed"
timeout -s TERM -k 5 30 long_cmd      # TERM at 30s, KILL 5s later if still alive
ulimit -n                             # open file limit
nice -n 10 cmd; ionice -c3 cmd        # lower CPU / I/O priority
```

`timeout` exits 124 on timeout, which is distinguishable from a command failure — use it. `ulimit`
is per-process and inherited; a forking script can exhaust the system despite a sane per-process
limit.

## Common mistakes

- `kill -9` first, then wondering why cleanup did not run.
- Killing a PID from a stale file (`kill $(cat app.pid)`) after PID reuse — verify with
  `ps -p "$pid" -o cmd=` before signalling.
- Trapping TERM but blocking in a foreground `sleep`, so the trap never fires.
- `wait` on one PID and assuming all background jobs succeeded.
- Using `$$` inside a subshell for a lock file.
- Leaving a `&` job running while the script exits, then having it killed by SIGHUP in some
  environments and not others.
- `set -e` plus a background job: a failure in a background job does not abort the script; you must
  `wait` and check.

## Production notes

- Entrypoint pattern: `trap 'forward TERM; exit 143' TERM` → start the app with `exec` if it is the
  only child (`exec` replaces the shell, so signals reach the app directly and no reaping is
  needed), otherwise background + `wait`.
- `exec "$@"` at the end of an entrypoint is the single most valuable line: it removes the shell
  from the process tree, so SIGTERM goes to the app and exit status propagates unchanged.
- Log PIDs with every process you start; `ps -o lstart=` disambiguates PID reuse.
- Bound every network call with `timeout`; a script with no timeout is a script that can hang a
  deploy pipeline for an hour.
