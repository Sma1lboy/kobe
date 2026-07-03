---
"@sma1lboy/kobe": patch
---

Fix: `kobe api fan-out --count N` now rejects an over-cap `N` before allocating instead of after. The `--count` branch built a `new Array(N)` of vendors and only then checked it against the fan-out cap, so a large `--count` (e.g. `--count 1000000000`) allocated a huge array — hanging or crashing the process with an out-of-memory error — before the "exceeds the cap" message it should have produced immediately. It now guards `N` against the cap up front, symmetric to the `--agents` spec path which already did so, so an over-cap request fails fast with the same clear error.
