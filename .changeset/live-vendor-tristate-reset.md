---
"@sma1lboy/kobe": patch
---

fix: dead engines release their tab identity; liveness probes the reporting engine

Two identity staleness bugs. (1) A chat tab spawned with a vendor (e.g. codex) kept wearing that name in the sidebar tree forever, even after ctrl+C left it a bare shell — and after the user launched a different engine in it. The live process probe is now tri-state (engine / confirmed-none / can't-look) and outranks the tab's creation pin everywhere: the pin only covers the spawn window the probe can't see, a confirmed engine-free shell is labelled a shell, and a tab running a different engine is named after what actually runs. (2) A task whose configured vendor is a custom wrapper id (`claudecpa`) lapsed to the idle glyph mid-turn: the activity watchdog probed the wrapper id's (nonexistent) transcript store and read silence. The hook's own `--engine` tag now rides the report, so the daemon probes the engine that actually reported.
