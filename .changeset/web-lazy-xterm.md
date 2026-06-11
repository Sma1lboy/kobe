---
"@sma1lboy/kobe": patch
---

Web perf: the xterm terminal (the app's heaviest dependency) is now lazy-loaded, so it splits into its own chunk fetched only when a vendor/terminal tab first opens instead of bloating first paint. The dashboard's main chunk drops from ~352KB to ~68KB; xterm's ~288KB loads on demand behind a "Loading terminal…" fallback.
