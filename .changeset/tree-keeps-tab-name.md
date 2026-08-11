---
"@sma1lboy/kobe": patch
---

Sidebar tree rows show the conversation name again instead of "claude 1". The tree reads each tab's recorded title, and that recording used to be the engine's whole status line — so the rule deliberately threw it away and fell back to the vendor default. Since the status prefix is now stripped where the title enters the app, the recording IS the name, and the tree keeps it. Titles recorded before that fix still carry their prefix, so it is stripped again on display and old snapshots heal with no migration; a recording that was nothing but decoration still falls through to the first-prompt summary or the vendor default.
