---
"@sma1lboy/kobe": patch
---

Internal: lock the web theme palette resolution with a contract test — every one of the 7 bundled themes must resolve (def-ref chains and all) to a complete palette where every `--color-*` token the dashboard sets is a valid 6-digit hex, plus coverage for the `/api/themes` route. Guards against a theme JSON change silently dropping a token and breaking the web theming.
