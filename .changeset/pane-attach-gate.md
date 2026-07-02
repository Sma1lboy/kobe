---
"@sma1lboy/kobe": patch
---

Background (detached) task sessions no longer burn CPU: the Tasks/Ops pane
pollers — sidebar git-HEAD spawns, the Ops transcript-mtime sweep and
capture-pane turn-status probe, the tasks.json backstop stat, and the live
history tail — now check a shared, cached "is this session attached?" gate and
skip their expensive work while nobody is looking. With ~10 sessions open this
was ~25 pane processes at ~30% combined idle CPU; detached panes now cost one
cached tmux probe per 3s. The first tick after re-attach resumes full cadence,
and any probe failure fails open so a visible pane can never quiesce itself.
