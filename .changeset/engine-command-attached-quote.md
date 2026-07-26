---
"@sma1lboy/kobe": patch
---

Fix a custom engine launch command in Settings → Engines mis-splitting an attached quoted flag: `claude --append-system-prompt="be terse"` (the common `--flag="value with spaces"` idiom) was parsed as two broken argv elements (`--append-system-prompt="be` and `terse"`) instead of one (`--append-system-prompt=be terse`), because the tokenizer only honored a quote that started a word. The command splitter now treats a quote opening anywhere in a token as a quoted span that concatenates with the surrounding text — matching a shell — so both the attached (`--flag="…"`) and separated (`--flag "…"`) forms launch the engine with the argv you configured; an unterminated quote runs to the end of the command rather than being kept literally.
