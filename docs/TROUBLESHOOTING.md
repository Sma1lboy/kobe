# Troubleshooting

User-facing symptom → cause → fix, for the questions that keep coming back.
One section per symptom; keep entries short and command-exact.

## Copy from the embedded terminal doesn't reach my clipboard (especially over SSH)

**How copy works.** kobe's embedded terminal is a full-mouse TUI: it enables
the terminal's mouse reporting (clicks focus panes, tabs are clickable, the
wheel routes to the app). Mouse reporting hands drag-selection to kobe, so
your terminal emulator's native selection no longer participates — the same
trade every mouse-enabled TUI (tmux, `vim` with `mouse=a`) makes. kobe
implements its own grid selection instead: drag to select (pane-aware, works
inside splits), release to copy. Delivery is dual-channel:

1. a pipe into the platform clipboard command on the machine kobe runs on
   (`pbcopy` / `wl-copy` / `xclip` / `xsel`), and
2. an **OSC52** escape sequence written to the tty.

**The SSH case.** When you SSH into the machine running kobe, channel 1 lands
on the *remote* machine's clipboard — not yours. The only channel that can
reach the clipboard of the machine you are physically at is OSC52: it travels
back through the SSH tty and is executed by your local terminal emulator.

```
kobe (remote) ──OSC52──▶ ssh tty ──▶ your terminal app ──▶ your clipboard
```

So if copy "works locally but not over SSH", the break is almost always at
the **receiving terminal app** (the one drawing pixels in front of you):

| Terminal (the one you're physically using) | OSC52 clipboard write |
|---|---|
| iTerm2 | **Off by default** — Settings → General → Selection → check *"Applications in terminal may access clipboard"* |
| Ghostty | Allowed (`clipboard-write = allow` is the default) |
| kitty / WezTerm | Allowed or ask, configurable |
| Terminal.app (macOS) | **Unsupported** — no fix; use another terminal or the escape hatch below |

**tmux in the path?** If kobe itself runs inside a remote tmux session, tmux
swallows OSC52 unless told to forward it:

```tmux
set -g set-clipboard on
```

**Escape hatch that always works:** hold **Option** (macOS) / **Shift**
(most Linux terminals) while dragging. That bypasses mouse reporting entirely
and uses your terminal's native local selection + copy — guaranteed to land
on your local clipboard, at the cost of selecting across the whole kobe
window (no pane awareness), exactly like tmux.

**Remote workflows:** the kobe web dashboard sidesteps all of this — the
browser owns the clipboard.

## Mouse wheel in the embedded terminal

The wheel follows real terminal-emulator semantics, in order:

1. the embedded app enabled mouse tracking (claude's transcript, `vim`,
   `less --mouse`) → the wheel is forwarded; the app scrolls itself;
2. fullscreen app without mouse tracking → 3 arrow keys per tick;
3. plain shell → kobe's local scrollback (same channel as
   `ctrl+pgup` / `ctrl+pgdn`; scroll to the bottom to resume following).

If scrolling "does nothing" inside an app, that app received the events and
chose not to scroll — check its own mouse setting (e.g. `:set mouse=a`).
