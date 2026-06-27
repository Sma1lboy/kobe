---
"@sma1lboy/kobe": patch
---

Validate the persisted `lastSelectedVendor` preference before it drives engine selection. A corrupt or typo'd value in `state.json` previously cast straight to a `VendorId` and flowed into the new-task / quick-task / settings default-engine pickers as a bogus id that silently failed to launch. The four read sites now run it through a new `resolvePersistedVendor` helper that accepts only the three built-ins plus the user's registered custom engines and otherwise falls back to `claude`.
