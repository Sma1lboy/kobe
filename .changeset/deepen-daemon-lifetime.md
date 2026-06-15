---
"@sma1lboy/kobe": patch
---

Internal: the daemon's lazy-shutdown + collector-gate policy is now a deep, unit-tested module (`DaemonLifetime`) instead of loose functions and a shared `stopping` flag scattered across `server.ts`. The gui refcount, the idle-shutdown grace timer, the collector gate, and the stopping flag — three interdependent rules — now live behind one small interface, with the live client set still its source of truth (no counter to drift) and an injected clock so the policy is testable without a real socket. No behavior change; the end-to-end socket tests are unchanged and a new isolated unit test pins the rules.
