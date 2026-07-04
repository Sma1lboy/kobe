---
"@sma1lboy/kobe": patch
---

Experimental native chat backend (`KOBE_TUI=1`): a claude task's engine pane runs the new `kobe chat` pane — an opentui-rendered transcript + composer that drives one headless `claude -p --output-format stream-json` turn per prompt — instead of the always-on interactive CLI. No engine process idles between prompts, cutting the per-task CPU/heat cost of many parallel tasks. The pane renders the SDK stream-json messages verbatim (text/thinking/tool_use blocks, usage + cost from `result`), resumes the worktree's newest claude session on boot, and interrupts a running turn with `esc`. Claude-vendor local tasks only; other vendors and remote tasks keep the tmux handover.
