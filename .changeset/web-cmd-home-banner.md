---
"@sma1lboy/kobe": patch
---

`kobe web` now prints which daemon home it's serving (`home: …/.kobe (production)` or `home: sandbox: <path>` when `KOBE_HOME_DIR` is set) right under the URL, so it's never a mystery whether the dashboard is showing your production task index or a sandbox — matching the `dev`/`dev:sandbox` banner.
