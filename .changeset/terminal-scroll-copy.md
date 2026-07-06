---
"@sma1lboy/kobe": patch
---

The embedded terminal's mouse wheel now behaves like a real terminal emulator: apps that enable mouse tracking (claude's transcript, vim, less) receive the wheel and scroll natively, fullscreen apps without it get the classic arrow-key fallback, and only a plain shell scrolls kobe's local scrollback (same channel as ctrl+pgup/pgdn). It also supports copy-on-select: drag to select text and it lands on the system clipboard via OSC52 the moment you release — the tmux copy-mode convention, working over SSH too.
