---
"@sma1lboy/kobe": patch
---

Internal: locked down the subtle web logic with unit tests. The notification rising-edge rule is extracted to a pure `shouldNotify()` and the theme precedence to `resolveEffectiveTheme()`, both covered; relative-time bucketing is covered too. Also made the theme module import-safe outside a browser (the palette fetch is gated to a window context). No behavior change — 60 web tests now (up from 38).
