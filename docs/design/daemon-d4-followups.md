# Daemon D4 — what happened to the resilience polish bucket

> Companion to [`daemon.md`](./daemon.md). D3 (multi-attach broadcast)
> shipped in commit `61cfe24` (KOB-36). This memo walks each D4 bullet,
> records the per-item decision, and links to the child Linear issue
> where one was filed. Future agents: read this before re-opening
> "should we add X to the daemon?" — the answer is probably already
> here.
>
> Note: as of KOB-136 the standalone `kobed` bin was merged into
> `kobe daemon ...`. References below use the original naming.

Parent epic: [KOB-35 — Daemon split](https://linear.app/codesfox/issue/KOB-35).

## Item index

| # | D4 bullet | Decision | Issue |
|---|---|---|---|
| 1 | Event `seq` + replay-since-seq | **Pull forward** | [KOB-38](https://linear.app/codesfox/issue/KOB-38) |
| 2 | Daemon-side per-client backpressure | **Pull forward** | [KOB-39](https://linear.app/codesfox/issue/KOB-39) |
| 3 | Socket auth token in path | **Stay deferred** (token); **pull forward** narrow chmod fix | [KOB-41](https://linear.app/codesfox/issue/KOB-41) |
| 4 | `kobed status --json` | **Already covered** | n/a |
| 5 | Structured logging to `~/.kobe/logs/` | **Pull forward** | [KOB-40](https://linear.app/codesfox/issue/KOB-40) |

## 1. Event `seq` + replay-since-seq — pull forward (KOB-38)

`KobeDaemonClient` (`packages/kobe/src/client/index.ts`) has no
reconnect logic at all. `socket.on("close")` rejects pending requests
and zeroes `this.socket` — that's it. `RemoteOrchestrator` keeps
holding the dead client.

Concrete flake: `kobed restart` while a TUI is attached. The TUI
**never recovers** today, even though `daemon.md` §8 explicitly says
"TUI reconnects automatically." That's a doc-vs-reality mismatch
already — D3 shipped without closing the loop.

Even after we add reconnect, naive resubscribe loses every event
between disconnect and reconnect. The design doc punts this to D4
("seq infrastructure goes in once a flake actually shows up"). The
flake has shown up — kobed restart is the first manual recovery
operation a developer learns, and the TUI just dies.

**This is the starting point.** Reconnect + seq are the same change in
practice (you can't replay without a sequence cursor), and they unlock
clean diagnostics for items 2 and 5.

## 2. Per-client backpressure — pull forward (KOB-39)

`daemon/server.ts` `broadcast()` ignores `socket.write()`'s return
value and never handles `drain`. With one slow / paused client and a
high-frequency `chat.delta` stream, daemon heap grows unbounded — no
threshold, no eviction, no metric.

Failure mode is not theoretical: any `Ctrl+S`-frozen terminal,
suspended SSH session, or debugger-paused TUI silently pins the
daemon's memory. With multi-attach now real (D3) and Jackson's
typical 10+ tabs each emitting tokens, this is the next thing to
flake.

Coupled to KOB-38: once backpressure can drop / coalesce
non-critical deltas, replay-since-seq covers the gap.

## 3. Socket auth token in path — partial pull-forward (KOB-41)

`daemon.md` §10 says: "`~/.kobe/daemon.sock` is mode `0600` and that's
the auth — single-user assumption." The actual code does **not** chmod
the socket. Node creates the unix socket with the process umask;
default macOS `0022` umask gives `0755`. The stated permission
guarantee isn't enforced.

A full token-in-path scheme is overkill for kobe's single-user laptop
threat model. **Stay deferred** on the token. **Pull forward** the
narrow `chmod 0600` fix (KOB-41, labeled Bug) so the doc's stated
contract holds.

If we ever target shared dev hosts / multi-user CI runners, revisit
the token scheme.

## 4. `kobed status --json` — already covered

`packages/kobe/src/bin/kobed.ts` line 16:

```ts
const status = await client.request<Record<string, unknown>>("daemon.status")
console.log(JSON.stringify(status, null, 2))
```

`kobed status` **already prints JSON.** The D4 bullet imagined an
opt-in `--json` flag layered onto a pretty default, but the current
default is JSON. If anything we should consider adding a pretty
default and a `--json` opt-in later, but that's a follow-up small
enough to roll into KOB-40 (logging) or KOB-39 once one of those
lands.

No Linear issue filed for this item.

## 5. Structured logging to `~/.kobe/logs/` — pull forward (KOB-40)

Daemon diagnostics today go through `console.log` / `console.warn` /
`console.error` (see `orchestrator/core.ts:1243`, `1258`, `1269`,
`1566`; `orchestrator/index/store.ts:138`, `180`, `404`, `426`, `432`,
`444`; `orchestrator/index/lockfile.ts:110`). The
`connectOrStartDaemon` helper spawns kobed with `stdio: "ignore"`, so
**every diagnostic written by an auto-started daemon is lost.** Same
for `kobed start &` from a shell.

This is a recovery / debuggability blackhole: when Jackson reports
"daemon crashed" or "tasks vanished," there's no on-disk record to
diff against. Reproducing live is the only option.

Pull forward independently — KOB-38 and KOB-39 both want a place to
log structured diagnostics (reconnect retries, slow-consumer
disconnects). Doing logging first means those issues ship with clean
observability instead of `console.log` debt to be ripped out later.

## Suggested ordering

1. **KOB-38** (reconnect + seq) — biggest user-facing pain, closes the
   doc-vs-reality gap on §8.
2. **KOB-40** (logging) — prerequisite for clean diagnostics on the
   other two.
3. **KOB-39** (backpressure) — depends on (1) for replay-after-drop
   semantics and (2) for structured slow-consumer logs.
4. **KOB-41** (chmod) — small hardening, can land any time.

`kobed status --json` is already done; revisit if we add a pretty
default.

## When to revisit "D4 is closed"

When all four child issues are Done, mark KOB-35's D4 row Done and
update `daemon.md` §9 to point at this memo. Until then leave the row
"deferred" so future agents don't think the polish is shipped.
