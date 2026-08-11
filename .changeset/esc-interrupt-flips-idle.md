---
"@sma1lboy/kobe": patch
---

An ESC-interrupted turn now flips the sidebar running state within seconds instead of sticking until the ~10min watchdog (issue #15). The engine's abort path fires no Stop hook, so the TUI watches the one signal an interrupt leaves — the engine's own title rewrite from its animated working frame to its resting form (engine-declared `workingPrefixes`) — confirms it against the hook-claimed running state with a Stop-race debounce, and reports `turn-interrupted` to the daemon so every attached client's badge flips.
