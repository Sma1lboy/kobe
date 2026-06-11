---
"@sma1lboy/kobe": patch
---

The web Settings page is now functional instead of decorative: a theme picker with live swatch previews of every bundled theme (clicking one applies + persists a web-local override that takes precedence over the TUI's pushed theme; "Follow TUI" clears the override so the dashboard tracks the TUI again), an Engines card listing the detected built-in + custom engines, and the existing connection/version detail. The theme module now resolves precedence cleanly (web-local override > daemon `ui-prefs` > claude fallback) and applies the persisted choice on first paint.
