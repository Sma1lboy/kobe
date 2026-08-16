---
"@sma1lboy/rove": patch
---

Fix the `perf:golden` `park-heap-reclaim` probe's machine-load flake (bimodal 2% vs 52%). The sweep's quiet gate (`PARK_QUIET_MS`) refused to park the just-filled tabs, so nothing ever parked and the old %-of-total-heap formula was really measuring GC laziness — ambient, load-dependent. The probe now fast-forwards the sweep clock so parking actually happens, counts typed-array backing stores (`extraMemorySize`, where xterm cells live) in the heap reading, and reports a self-normalizing ratio — heap freed as a share of the growth the 10 tabs themselves caused — from the median of three settled GC samples.
