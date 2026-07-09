---
"@sma1lboy/kobe": patch
---

Dev-mode keymap diagnostic: dispatch now warns when one keypress matches two ENABLED bindings.

Two enabled entries sharing a chord resolve by LIFO stack order, which the React migration inverted (ancestors on top) — the class of bug behind ctrl+w failing to close a split leaf. Under `KOBE_DEV=1` (all dev/dev:sandbox/dev:mock scripts) the dispatcher scans for a shadowed second match on every hit and logs it once per chord, respecting modal barriers. Production keeps the read-one-config-on-hit fast path untouched.
