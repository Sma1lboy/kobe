---
"@sma1lboy/kobe": patch
---

**`prefix F` quick-create is now prompt-first, and jumps you into the new task.** Instead of reusing the rename dialog (whose field literally read "title"), the quick chord opens a small composer whose **prompt** field is focused on open — type a prompt, hit enter, and the task is created with the prompt delivered as its first message. Engine and branch sit right there too (`tab` cycles prompt → engine → branch, `ctrl+e` switches engine) but default from the task you fired it in, so the fast path stays type-and-go. On submit it also switches you straight into the new task's session rather than leaving you on the old tab. (The full `n` dialog is unchanged for when you want to pick a different repo / clone / adopt.)
