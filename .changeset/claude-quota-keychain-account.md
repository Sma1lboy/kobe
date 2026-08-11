---
"@sma1lboy/kobe": patch
---

Fix the Settings usage dashboard staying empty for Claude on machines whose
Keychain holds more than one `Claude Code-credentials` item. The probe looked
the credential up by service name alone, so `security` returned whichever item
it scanned first — often a stale row left by an older CLI, whose expired token
made the probe give up before it ever reached the usage API. It now pairs `-a
$USER` with `-s`, exactly as the Claude CLI's own keychain reader does.
