---
"@sma1lboy/kobe": patch
---

Internal (web): vendor-identity rules now live in one module (`src/lib/vendor.ts`) instead of being split three ways. The unset-vendor default (`"claude"`) was independently re-coalesced in `engineLabel` (engines.ts), `distinctTaskVendors` (task-list.ts), and `defaultReviewTemplate` (review.ts); the per-row "engine label only when the workspace mixes engines" rule was inlined in AppShell. All of it — `DEFAULT_VENDOR` / `resolveVendor` / `engineLabel` / `distinctTaskVendors` / `isMixedEngineWorkspace` / `perRowEngineLabel` — now lives behind `vendor.ts`, so the default is one line and the rules are unit-tested without rendering a row. `engines.ts` keeps only its job: fetching the engine-owned list from the bridge. No behavior change.
