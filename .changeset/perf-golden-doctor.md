---
"@sma1lboy/kobe": patch
---

perf-golden: a release-ritual performance doctor (`bun run perf:golden`).

Ten end-to-end golden testcases against throwaway sandbox infrastructure — CLI cold start, VT 1MB parse throughput, daemon connect+replay and RPC p50, PTY spawn→first output, park→wake replay latency, hot-tab memory cost, park heap reclaim, and standalone-binary compile time + size + boot smoke (the native-addon red line). Every ceiling lives in one GOLDEN table, set 2-3× the reference numbers so it flags structural regressions, not machine jitter; `--fast` skips the binary metrics. Wired into the release gates and documented in docs/HARNESS.md §Performance contracts.
