---
"@sma1lboy/kobe": patch
---

Hidden terminal tabs park again — automatically and losslessly: the sweep serializes each idle tab's full screen (~100KB) before releasing its multi-MB emulator, and switching back restores the serialized state plus the host's exact byte delta since park, bit-identical to never detaching. Stale parks (respawned key, delta trimmed past the ring window) degrade to the previous full-replay behavior.
