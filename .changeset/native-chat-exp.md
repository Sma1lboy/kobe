---
"@sma1lboy/kobe": patch
---

Experimental native opentui workspace (`KOBE_TUI=1`): `kobe` boots a single-process Sidebar / Chat / Files app instead of entering the tmux handover. The chat column runs one turn per prompt through the ai@7 AI SDK harness (`HarnessAgent`) and renders the streamed `UIMessage` natively — text/reasoning/tool parts in place, no vendor transcript parsing — so no long-lived engine process idles between prompts. Claude and Codex plug in behind the same contract via `@ai-sdk/harness-*` (subscription auth, no API key). The default tmux product path is unchanged when the flag is unset.
