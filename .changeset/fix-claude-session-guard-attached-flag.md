---
"@sma1lboy/kobe": patch
---

Fix a custom Claude launch command that pins its own session with the attached `--flag=value` form (`claude --resume=abc`, `--session-id=abc`, `--from-pr=42`) getting a second, conflicting `--session-id` force-appended by kobe — which Claude then rejects. The guard that detects an already-session-controlled command matched whole tokens, so it saw the separated form (`--resume abc`) but missed the attached form that the same command parser deliberately keeps as one token; it now compares the flag name before any `=`, so both forms launch the session you configured.
