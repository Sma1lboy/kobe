---
"@sma1lboy/kobe": patch
---

Fix Claude Code binary discovery picking the oldest nvm-installed Node instead of the newest: when `claude` was installed under several nvm node versions, the fallback scan sorted the version directories as plain strings, so a single-digit major like `v8.17.0` outranked `v18.20.0` and kobe could launch the engine from an outdated Node. The scan now orders versions numerically, newest first.
