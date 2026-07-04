---
"@sma1lboy/kobe": patch
---

Experimental native opentui workspace (`KOBE_TUI=1`): `kobe` boots a single-process Sidebar / Chat / Files / Terminal app instead of entering the tmux handover. The chat column drives one headless `claude -p --output-format stream-json` turn per prompt, renders SDK stream-json messages verbatim (text/thinking/tool_use blocks, usage + cost from `result`), resumes the worktree's newest claude session on boot, and interrupts a running turn with `esc`. The default tmux product path is unchanged when the flag is unset.
