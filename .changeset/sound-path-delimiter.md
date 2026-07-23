---
"@sma1lboy/kobe": patch
---

Fix the notification chime never playing on Windows: player discovery split `PATH` on a hard-coded `:`, which shattered every Windows entry on its drive-letter colon (`C:\Windows\System32`) so no directory ever matched and `powershell.exe` was never found — the audible ding is now discovered using the platform's list delimiter (`;` on Windows, `:` elsewhere), while POSIX behavior is unchanged.
