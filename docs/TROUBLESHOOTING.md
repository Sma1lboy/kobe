# Troubleshooting

User-facing symptom → cause → fix, for the questions that keep coming back.
One section per symptom; keep entries short and command-exact.

## Windows opens Rove, but engine and terminal tabs never start

Windows needs three separate runtimes:

- **Bun ≥ 1.3.11** runs the Rove CLI and TUI.
- **Node.js** runs the Windows Hosted PTY process. A Bun-only global install
  does not install Node for you.
- **Git for Windows**, including its Git Bash, supplies the POSIX shell used by
  every engine and terminal launch. Rove deliberately does not use the WSL
  `bash.exe`, because it cannot address the Windows worktree correctly.

Start with:

```powershell
rove doctor
where.exe node
where.exe git
```

Install Node.js if Doctor says the Windows PTY host cannot find it. If the
engine launch names `C:\Program Files\Git\bin\bash.exe`, install Git for
Windows or set `SHELL` to the full, existing Windows path of another compatible
Bash. An inherited MSYS value such as `/usr/bin/bash` is not a spawnable
Windows executable path.

Remote-project password auth is not available on Windows; use `--key` or
ssh-agent. Only macOS has the keychain integration used by `--password`.

## The daemon, sidebar, or a terminal session looks wedged

Run the read-only diagnosis first:

```bash
rove doctor
rove api inspect --task-id <task-id> --pretty
```

`inspect` does not start missing services. It joins daemon activity, Hosted
PTY sessions, persisted tab snapshots, and durable abnormal-exit records, so
it is the best first attachment for a badge, label, or engine-crash report.
`rove doctor --report` writes a bundle containing the same diagnosis plus
recent logs and environment details.

The raw logs live under the active Rove home (normally your OS home):

| Path | Contains |
|---|---|
| `~/.kobe/daemon.log` | daemon startup, crashes, RPC and web-transport failures |
| `~/.kobe/pty.log` | Hosted PTY startup and session-host failures |
| `~/.kobe/client.log` | TUI/pane connection, disconnect, and reconnect diagnostics |

After an upgrade, a daemon can still be running old in-memory code. Doctor
reports that version mismatch; fix it with `rove daemon restart`. If the PTY
host itself is wedged, `rove reset` stops both runtimes and all live terminal
and engine sessions, but does not touch git worktrees. Read the confirmation
carefully before proceeding.

## What terminal output does Rove persist after a crash?

Hosted PTY output is not always memory-only. Two bounded recovery stores live
under `~/.kobe/` (or the selected Rove home):

- `pty-exits.json` records **abnormal** exits only. It keeps at most the newest
  50 session records, with exit metadata and up to the last 40 plain-text
  output lines per session. `rove api inspect` exposes these as
  `sessionExits`; clean exits are omitted.
- `pty-sessions/` freezes each hosted session's launch metadata and bounded
  scrollback ring so a PTY-host crash, restart, or machine reboot can restore
  the old screen and respawn the launch command. An explicit tab close or task
  archive drops that session's frozen record; a reset asks the running host to
  start fresh.

These files can contain text that was visible in the embedded terminal. Treat
the Rove home with the same permissions and backup policy as shell history and
engine transcripts; do not describe terminal output as “never written to
disk.”

## Rove says the daemon serves a different home

Rove refuses a daemon whose handshake reports a different state home before
accepting any tasks from it. This normally means a `dev:sandbox` or custom-home
process inherited the production socket override. The error names both homes
and prevents the foreign task list from blanking or replacing the real one.

Check the overrides in the shell that started the unexpected daemon:

```bash
env | grep -E '^(ROVE|KOBE)_(HOME_DIR|DAEMON_SOCKET_PATH)='
rove doctor
```

Stop that daemon from the same environment, then clear the inherited overrides
before starting the intended instance:

```bash
rove daemon stop
unset ROVE_DAEMON_SOCKET_PATH KOBE_DAEMON_SOCKET_PATH
unset ROVE_HOME_DIR KOBE_HOME_DIR
rove daemon restart
```

If you intentionally use a custom home, re-export its `ROVE_HOME_DIR` before
the restart instead of unsetting it. Do not point two homes at one daemon
socket: the server refuses a live takeover, and clients reject the wrong
owner.

## Claude or Codex activity badges do not update

Rove installs its own merge-safe, global activity hooks when the TUI launches:

- Claude Code definitions live in `~/.claude/settings.json`.
- Codex definitions live in `~/.codex/hooks.json`. Codex requires the user to
  trust non-managed hooks once through `/hooks`; Rove writes the definition but
  never bypasses that approval.

Fully relaunch Rove to re-run hook installation, then approve the Rove command
inside Codex's `/hooks` page if needed. Use `rove api inspect --task-id <id>`
to compare hook activity with the PTY/process observation. Codex does not
currently expose clean signals for every state (failure, session end, and
permission waiting), so Rove's polling/PTY fallback remains part of the normal
result.

The hook command itself is intentionally harmless: `rove hook …` always exits
0 and never starts the daemon; sessions outside tracked Rove worktrees quickly
no-op. `rove hook setup` is deprecated and now performs cleanup only. Older
Rove versions installed a Claude `WorktreeCreate` provider hook that could
break `claude --worktree`; current launches remove Rove's old entry while
preserving user hooks and use an observer instead.

## Copy from the embedded terminal doesn't reach my clipboard (especially over SSH)

**How copy works.** Rove's embedded terminal is a full-mouse TUI: it enables
the terminal's mouse reporting (clicks focus panes, tabs are clickable, the
wheel routes to the app). Mouse reporting hands drag-selection to Rove, so
your terminal emulator's native selection no longer participates. Every
mouse-enabled TUI (tmux, `vim` with `mouse=a`) makes the same trade. Rove
implements its own grid selection instead: drag to select (pane-aware, works
inside splits), release to copy. Delivery is dual-channel:

1. a pipe into the platform clipboard command on the machine Rove runs on
   (`pbcopy` / `wl-copy` / `xclip` / `xsel`), and
2. an **OSC52** escape sequence written to the tty.

**The SSH case.** When you SSH into the machine running Rove, channel 1 lands
on the *remote* machine's clipboard, not yours. The only channel that can
reach the clipboard of the machine you are physically at is OSC52: it travels
back through the SSH tty and is executed by your local terminal emulator.

```mermaid
flowchart LR
  Rove["Rove (remote)"] -- "OSC52" --> tty["ssh tty"]
  tty --> app["your terminal app"]
  app --> clip["your clipboard"]
```

So if copy "works locally but not over SSH", the break is almost always at
the **receiving terminal app** (the one drawing pixels in front of you):

| Terminal (the one you're physically using) | OSC52 clipboard write |
|---|---|
| iTerm2 | **Off by default**: Settings → General → Selection → check *"Applications in terminal may access clipboard"* |
| Ghostty | Allowed (`clipboard-write = allow` is the default) |
| kitty / WezTerm | Allowed or ask, configurable |
| Terminal.app (macOS) | **Unsupported**: no fix; use another terminal or the escape hatch below |

**tmux in the path?** If Rove itself runs inside a remote tmux session, tmux
swallows OSC52 unless told to forward it:

```tmux
set -g set-clipboard on
```

**Escape hatch that always works:** hold **Option** (macOS) / **Shift**
(most Linux terminals) while dragging. That bypasses mouse reporting entirely
and uses your terminal's native local selection + copy, which always lands on
your local clipboard, at the cost of selecting across the whole Rove
window (no pane awareness), exactly like tmux.

**Remote workflows:** the rove web dashboard sidesteps all of this. The
browser owns the clipboard.

## Right-click opens my terminal's menu instead of Rove's

**Why.** The outer terminal's context menu lives in the app layer, ahead of
the TTY: it decides what to do with a right-click before mouse reporting
ever sees it. iTerm2 (and several other emulators) keep right-click for
their own menu by default, so Rove's row menu never gets the event. No TUI
can take that back from inside the terminal — the fix is a terminal
setting, not a Rove one.

**iTerm2** ships an official escape hatch for exactly this
([Pointer preferences](https://iterm2.com/3.3/documentation-preferences-pointer.html)):

- Settings → **Pointer** → check *"Ctrl-click reported to apps, does not
  open menu"*. **Ctrl+left-click** is then reported to Rove as a
  right-click and the row menu opens; plain right-click keeps iTerm2's
  menu, so you lose nothing.
- Alternatively, Settings → Pointer → *Mouse Button Actions* can rebind
  the right-button gesture itself away from iTerm2's menu.

**Terminal.app** has no reporting toggle for this; use the keyboard
fallback below.

**Fallback that works everywhere:** every row-menu entry is also a direct
chord on the row itself (`r` rename, `a` archive, `d` delete, …) — see
[KEYBINDINGS.md](./KEYBINDINGS.md). The one right-click-only surface today
is the project header's menu.

## Mouse wheel in the embedded terminal

The wheel follows real terminal-emulator semantics, in order:

1. the embedded app enabled mouse tracking (claude's transcript, `vim`,
   `less --mouse`) → the wheel is forwarded; the app scrolls itself;
2. fullscreen app without mouse tracking → 3 arrow keys per tick;
3. plain shell → Rove's local scrollback (same channel as
   `ctrl+pgup` / `ctrl+pgdn`; scroll to the bottom to resume following).

If scrolling "does nothing" inside an app, that app received the events and
chose not to scroll. Check its own mouse setting (e.g. `:set mouse=a`).

## Memory stays high after upgrading from a pre-0.8 build

rove 0.8 replaced the old tmux runtime with the PureTUI + Hosted PTY backend,
but upgrading the package does not stop sessions that a pre-0.8 build already
left running. Those old `tmux -L kobe` sessions keep their `bun` / engine
process groups resident, so memory can look unchanged after the upgrade.

`rove doctor` now reports them:

```
legacy tmux: ⚠ tmux 3.5a — 2 pre-v0.8 session(s) on `kobe`
             20 process(es) across 8 pane(s), 1008.5 MB RSS total
             → run `rove reset` to stop this retired runtime safely
```

**Fix:** `rove reset`. It stops the daemon and Hosted PTY host, then SIGTERMs
each legacy pane process group before killing the retired tmux server (a bare
`tmux kill-server` would leak engines that ignore `SIGHUP`). Worktrees and the
task index are untouched; add `--hard` only if you also want to wipe task/UI
state.
