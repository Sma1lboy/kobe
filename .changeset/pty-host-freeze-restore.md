---
"@sma1lboy/rove": patch
---

fix: a pty-host restart no longer takes the terminal work scene with it. The host now freezes every session's metadata and scrollback ring to `<home>/.kobe/pty-sessions/` (throttled while streaming, on exit, and at shutdown), and a restarted host — after a crash, a machine reboot, or an idle-exit — thaws each session as a dead "restored" corpse: reattaching replays the old screen and respawns the launch command in place. Engine tabs compose with the existing dead-reattach `--resume`, so the conversation comes back too. CLI-started sessions (`rove api add`/`send`) now pin their claude conversation id up front and record it in the tab snapshot once started, making headless tasks resumable the same way. `rove reset` keeps its starts-fresh contract by wiping the store, and explicitly closed/archived sessions drop their record — an intentional end is never resurrected. Design: `docs/design/pty-freeze.md`.
