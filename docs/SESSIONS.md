# Sessions: what survives what

Short answer: **quitting Rove stops nothing.** A reboot ends the running
processes but restores their screens and relaunches them on attach; only an
explicit `rove reset` starts truly fresh.

## What survives

| If you… | Engine keeps running | Scrollback | Tasks + worktrees | Conversation |
|---|---|---|---|---|
| Quit the TUI | ✓ | ✓ | ✓ | ✓ |
| Drop your SSH connection | ✓ | ✓ | ✓ | ✓ |
| `rove daemon restart` | ✓ | ✓ | ✓ | ✓ |
| Reboot, or the pty-host dies | — relaunched on attach | ✓ restored | ✓ | ✓ resumable |
| `rove reset` | — | — | ✓ | ✓ resumable |

![The TUI detaches while the engine process, scrollback ring, and task list stay lit below](assets/detach-survives.png)

The first three rows are the whole point: the TUI is a viewport, and the
daemon is replaceable. The fourth row is the freeze/restore contract: nothing
keeps processes alive across a reboot, but the PTY host persists every
session's metadata and scrollback to disk, so the next boot puts your screen
back and relaunches the session's command when you look at it. Your
*conversations* come back either way, because the engine wrote them. The last
row is the hard boundary — `rove reset` is the deliberate teardown, and it
wipes the frozen sessions too.

## Why: three processes, three lifetimes

```mermaid
flowchart TB
  subgraph clients["Attach clients (N, disposable)"]
    tui["Rove (TUI)"]
    web["rove web (browser)"]
  end
  subgraph daemon["rove daemon (state, refcounted)"]
    orch[Orchestrator]
    idx["tasks.json"]
  end
  subgraph host["rove pty-host (engine lifetime)"]
    p1["engine PTY — task A"]
    p2["engine PTY — task B"]
    ring["per-session scrollback ring"]
  end
  tui <-->|unix socket| daemon
  web <-->|HTTP/SSE| daemon
  tui <-->|unix socket| host
  orch --- idx
  p1 --- ring
  p2 --- ring
```

- **TUI and web** are pure attach clients. Closing one touches nothing else.
- **The daemon** owns your task index, worktree records, and the event bus.
  It starts on first launch and stops after the last attached GUI disconnects,
  unless an enabled routine or a live session in the PTY host holds it alive —
  while an engine or shell tab is still running, the daemon stays up to
  collect its activity events, so the sidebar status dots survive a detach.
  In practice that makes the daemon resident as long as any task has an open
  tab (a task's last tab can't be closed, so "no live sessions" means every
  task archived or torn down). Restarting it is routine:
  `rove daemon restart`.
- **The PTY host** owns every engine and shell process, plus their
  scrollback. It's deliberately a *separate* process from the daemon, so a
  daemon restart never kills a running engine. Like the tmux server, it exits
  on its own only after sitting at zero live sessions. `rove reset` is the
  explicit teardown. While it runs, it freezes every session (metadata +
  scrollback ring) to `<home>/.kobe/pty-sessions/` — throttled to one write
  per few seconds while streaming, immediately on exit, and in full at
  shutdown. A host that comes back up (after a crash, a reboot, an idle-exit)
  thaws each record into a dead *restored* session: reattaching replays the
  old screen and respawns the command in place. Closing a tab, archiving a
  task, or `rove reset` deletes the record instead — an intentional end is
  never resurrected.

## Detaching and reattaching

There's no detach command — quitting **is** detaching. `ctrl+q`, closing the
terminal, an SSH drop: the connection closes and the engine keeps running.

Reattaching is just running `rove` again. A fresh TUI finds the background
sessions and reopens them. The existing session always wins, so reattaching
never restarts anything.

You can attach from several clients at once. Terminal output goes to every
client watching that session; your cursor, focus, and unsent draft stay
local to each one.

**Two exceptions to "everything survives a quit":**

- Archiving a task stops its sessions. A janitor sweeps sessions whose task
  is no longer live, so a headless `rove api archive` can't leak an engine
  that runs forever.
- An engine that exits on its own is kept as a dead session with its
  scrollback intact, so you can still see *how* it died.

## Scrollback

Two buffers, both bounded:

- **What a reattach replays** — the PTY host keeps ~512 KiB of recent output
  per session. The live copy is in memory, but the host also freezes it to
  disk (see above), so a host restart or reboot restores it with the session.
  Only `rove reset` throws it away.
- **How far you can scroll** — `terminal.scrollbackRows` in Settings →
  General → Terminal, default 1000 rows. Applies to terminals started after
  the change.

Reattach has a fast path: if a tab was only hidden, Rove replays just the
bytes written since it was parked, so waking it is bit-identical to never
having left. Attaching from a different-sized terminal resizes the session —
last attach wins, like tmux.

## Resuming a conversation

Process survival and conversation survival are different things. The
conversation is the engine's own file on disk, so it outlives every Rove
process, including a reboot.

- Claude tabs pin their conversation up front, so a tab that already ran
  comes back into the same conversation after a reboot rather than a blank
  one. Engines that can't take a caller-set session id (Codex and the rest)
  relaunch fresh.
- A tab found dead on attach gets **one** automatic resume attempt. If that
  dies too, the tab closes rather than respawning forever.
- `ctrl+a` `y` opens the resume picker for the active task — Rove's mirror of
  claude-code's `/resume`. It lists every session in the task's worktree.

## rove web as a second client

`rove web` is a second live client of the same daemon: same tasks, same
issues, same event stream. An open browser tab keeps the daemon alive exactly
like an attached TUI does.

One difference: the web dashboard's terminals are **not** views of the TUI's
sessions. They're spawned by a separate sidecar process with their own
lifetime. They survive page reloads and reconnects, and several browser views
of one tab share a single terminal — but they're independent of the sessions
your TUI is attached to.

## Not supported

Stated plainly so this page doesn't overpromise:

- **Surviving a reboot with processes intact.** Tasks, worktrees, scrollback,
  and conversations come back from disk, and sessions relaunch on attach —
  but the processes themselves die with the machine; any in-flight execution
  state inside them is gone.
- **Attaching from another machine.** The sockets are local only. Running the
  TUI over SSH works because both ends are on the same host; there's no
  native remote attach.
- **Event replay on reattach.** Reattaching resyncs from a snapshot, not by
  replaying events you missed.
- **Unsent drafts.** A typed-but-unsent message is local to that client and
  lost if it dies.
