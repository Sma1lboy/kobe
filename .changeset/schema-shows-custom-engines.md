---
"@sma1lboy/kobe": patch
---

fix: `rove api schema` and `--help` now list user-registered custom engines in the `--vendor` values, not just the built-ins. The runtime already accepted custom engine ids, but the discovery surface hid them, so an agent reading the schema never learned they existed.
