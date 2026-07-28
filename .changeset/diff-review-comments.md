---
"@sma1lboy/kobe": patch
---

Line-anchored review notes in the diff tab: move a line cursor over the read-only diff (j/k), mark a range (v), attach a short note (c — the shared text-prompt dialog), and send every unsent note for the task to its engine session as one batched prompt (s). Notes are per-task, kv-persisted (they survive pane switches and TUI restarts), and the prompt format (File / Line-or-range / quote-escaped User comment) is a pure shared function with unit tests. Chords are proposed pending owner sign-off.
