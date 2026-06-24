---
"@sma1lboy/kobe": patch
---

kobe now speaks more than English. A small reactive i18n framework (`src/tui/i18n`) ships with an English source-of-truth catalog and a full Simplified-Chinese (简体中文) translation, and the Settings dialog is the first surface routed entirely through it — every label, hint, toggle and the Feedback form now translate. A new **Language** picker under Settings → General switches between English and 中文; the choice applies live in-process and persists to `state.json` (`locale`), so other panes pick it up on their next boot, mirroring how the theme is applied. English stays the default. Locale parity (no missing/extra keys, no dropped `{placeholders}`) is gated in CI and by `bun run check-i18n`.
