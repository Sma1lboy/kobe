---
"@sma1lboy/kobe": patch
---

`kobe config` opens your kobe config file (`state.json` — theme, locale, engine + editor prefs) in your editor ($VISUAL / $EDITOR, else your configured editor, else nvim/vim/emacs/nano); `kobe config --path` just prints the path. `kobe doctor` now also reports the engine CLIs (claude / codex / copilot binary + account) and the local `git` version, and gains `kobe doctor --report`, which writes a `kobe-doctor-report.txt` bundle (diagnosis + recent daemon/pty-host logs + non-secret env) you can attach to a bug report.
