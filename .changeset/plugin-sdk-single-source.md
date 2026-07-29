---
"@sma1lboy/kobe": patch
---

Plugin SDK is now the single source of the wire contract: the daemon imports the event and channel catalogs from `@sma1lboy/kobe-plugin-sdk/contract` instead of keeping its own copies, and each kobe release auto-publishes the SDK to npm whenever its (independently changeset-versioned) version isn't there yet.
