# PTY multi-client attach — input and resize arbitration

> Design note (2026-08-21, issue #259, phase 4 of #255). Phases 1–3 gave the
> standalone PTY host (`kobe-daemon/src/daemon/pty-server.ts`) a session
> registry, a lifetime policy, and a TUI adapter. This note settles the last
> question: what a session does when **more than one client is attached to
> it** — a TUI pane, a browser tab, an `api` reader, in any combination.

Delivery is already multi-client. `pty.open` adds one sink per *connection*
to `PtySessionState.sinks`, keyed by connection identity, and never spawns a
second child for a key that already has one: a second open **attaches** to
the running child, gets the ring-buffer replay, and shares the same
monotonic offsets. Nothing about that changes here. What changes is that the
disagreements now have written rules, implemented in
[`pty-arbitration.ts`](../../packages/kobe-daemon/src/daemon/pty-arbitration.ts).

## Rule 1 — input: tmux semantics, everyone may write

Any attached client may `pty.write`. There is no exclusive-writer lock, no
read-only attach mode, and no takeover handshake. Ordering between clients
is arrival order at the host socket, and that is the whole rule: two clients
typing at once is exactly as messy as two people sharing a tmux session,
which is the behavior people already expect from a shared terminal.

One guarantee is worth stating precisely, because it is the one a shared
terminal can actually keep:

- **Contiguous within a payload.** Each `pty.write` reaches the child through
  exactly one synchronous `PtyChild.write`, so client B can never land bytes
  in the middle of client A's chunk. A pasted block arrives whole.
- **Not contiguous across payloads.** Whether A's two successive writes stay
  adjacent is not promised. Nothing could promise it.

Echo is not a separate mechanism: the child's output fans out to every sink,
so a keystroke typed in the browser appears in the TUI as ordinary child
output. No client echoes locally.

## Rule 2 — resize: last writer wins

The most recent `pty.resize` sets the child's grid, whoever sent it. A
reattach that carries a size counts as a resize (`pty.open` with `cols`/`rows`
on a live session); a size-less open — the headless readers — never resizes.

**The letterbox tradeoff, taken deliberately.** We do *not* size the child to
the smallest attached client. A shared session is sized for whoever touched
it last, so a client with a smaller viewport sees wrapped or truncated output
until it resizes back. That is the same ceiling tmux grouped sessions have,
and it is the right trade: shrinking a full-screen engine session because
somebody opened a narrow peek window would degrade the client that is
actually being used, in favour of one that is being watched.

Two guards stop that from thrashing:

- **Unchanged is a no-op.** `applyResize` returns false when the grid already
  matches, so a client re-reporting its own size (an xterm fit-addon fires on
  every layout pass) raises no `SIGWINCH` and triggers no repaint. This — not
  a timer — is what bounds the feedback loop. A time-based debounce only
  slows a genuine loop, while an idempotence check ends it, and any window
  long enough to matter would also swallow a real drag-resize.
- **The change is broadcast.** A real resize is sent to every attached
  connection *except* the one that asked, as a `pty.resized` event carrying
  `{ key, cols, rows }`. Before this, a client that did not initiate the
  resize had no way to learn its VT emulator had drifted from the child's
  grid, and quietly misrendered wrapped output until its own geometry
  happened to change.

**Consumer contract for the broadcast:** it is informational. Apply it to the
local emulator; do **not** answer it with a `pty.resize` request of your own.
Echoing it back is the one way to build a ping-pong the idempotence check
cannot see, because each side would then be reporting genuinely different
dimensions.

## Rule 3 — kill: unarbitrated, and deliberately so

#259 is silent on `pty.kill`; this note decides it. **`pty.kill` from any one
client ends the session for everybody** — the child is terminated, the
`pty.exit` frame fans out to every attached sink, the session is forgotten,
and its freeze record is dropped. It is `tmux kill-session`, not "close my
view". This is the shipped behavior, and it stays.

The alternative — last-detacher semantics, where kill only detaches while
another client watches — was rejected. A host key is `taskId::tabId`, so a
kill is a statement about the *tab*, not about one viewer's window, and the
tab is a first-class object the user owns. Making it conditional on who else
happens to be looking would mean a browser tab left open in a background
window keeps a closed tab's engine running forever, which directly
contradicts the invariant #257 established: an archived task cannot leave an
engine running.

The cost is a real UX gap, and it belongs to the clients, not the host: a
client whose session was killed by someone else receives `pty.exit` with no
indication that it was deliberate. It must not treat that as a crash and
respawn. Reporting "this terminal was closed elsewhere" is the correct
handling and is a follow-up for the web and TUI adapters.

## What multi-attach already did correctly

Audited and left alone — recorded here so the next change does not "fix" it:

- A second `pty.open` on a live key attaches; it does not respawn or steal.
  `created`/`respawned` are both false and the caller's spawn spec is ignored.
- Both clients get the ring replay. `sinceOffset`/`sincePid` delta replay is
  evaluated per request against the session's monotonic offsets, so two
  clients can hold independent offsets without interfering.
- `pty.detach` and a dropped socket remove only that connection's sink. The
  child keeps running, the survivor keeps streaming, and the `parked` flag
  (a detaching TUI's "I still hold a serialized screen") is only recorded on
  the **last** detach — a session with another viewer is not parked.
- `PtyLiveHold` and the host's idle-exit count **live children**, not attached
  clients, so one client leaving can never arm a teardown.
- `pty.kill` from one client ends the session for everybody (see Rule 3).

## Deliberate non-changes

- **No client refcount, no presence state.** Nothing here counts attached
  clients, so nothing here can leak one. That matters because there are
  **three** ways a client leaves — explicit `pty.detach`, socket close via
  `detachClient`, and a `ClientWriter` overflow that destroys the socket
  (which lands on the same close path) — and any future refcount must cover
  all three. `session.sinks` also counts **connections, not viewers**: one
  TUI process holds one sink per key however many split leaves render it, so
  `sinks.size` under-reports and is not a presence signal. Presence belongs
  in one registry, owned by the presence work, not derived here.
- **No debounce on the resize broadcast.** The TUI's live-reattach repaint
  trick wiggles the size one row and back (`pty-hosted.ts`), which now emits
  two `pty.resized` frames to other clients that cancel out. Coalescing them
  behind a timer would need per-session timers in an otherwise pure module
  and would delay every honest resize to smooth over one client's
  workaround. The wiggle itself is the thing to fix, in the TUI adapter.
- **`open()` stays synchronous.** Registering the sink, snapshotting the
  ring, and queueing the response happen in one `dispatch()` turn, and that
  synchrony is the only reason replay and the live stream can neither
  overlap nor gap. The resize broadcast added here is a synchronous fan-out
  for exactly that reason; no arbitration may introduce an `await` into the
  attach path.

## Known corner, not fixed

A client that **parks** (detaches while holding a serialized screen) records
the grid it parked at. If another client resizes the session while it is
parked, its delta replay on wake is bytes the child emitted at a different
width. In practice the park-restore open carries the client's own size, which
resizes the session back and makes the child repaint — so the screen
self-heals — but output produced during the parked window can still wrap
oddly. This is the same letterbox tradeoff as above, one step removed in
time, and is not worth a grid-epoch invalidation.
