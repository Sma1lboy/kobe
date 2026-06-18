---
"@sma1lboy/kobe": patch
---

Internal: daemon file-watch mechanics and read-only git environment policy now live behind shared helpers. The keybindings/UI-prefs watchers reuse one directory-watch trigger, and pane/daemon git probes share the same `GIT_OPTIONAL_LOCKS=0` policy module.
