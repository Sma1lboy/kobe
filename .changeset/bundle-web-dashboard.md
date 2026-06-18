---
"@sma1lboy/kobe": patch
---

Bundle the built web dashboard with the default kobe package and build it as part of `bun run build`. The web UI now imports JetBrains Mono through the Vite bundle via `@fontsource/jetbrains-mono` instead of relying on a checked-in public font file.
