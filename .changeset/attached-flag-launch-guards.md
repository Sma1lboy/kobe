---
"@sma1lboy/kobe": patch
---

A launch-command override that pins its own flag in the attached `--flag=value` form is now respected. The engine-command parser deliberately keeps `claude --resume=<id>` or `--append-system-prompt="…"` as one argv token, but the guards that decide "this command already controls its session / sets its own system prompt, don't add ours" only matched the space-separated form — so an override written the common attached way slipped past, kobe appended a second `--session-id` (claude then refuses to launch) or double-injected its worktree/dispatcher prompt over the user's own. All three guards now recognize both forms.
