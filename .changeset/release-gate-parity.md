---
"@sma1lboy/kobe": patch
---

Make the local release gate match what the release pipeline blocks publish on. `scripts/release.sh` ran lint/typecheck/test but not build or the behavior suite, so a check that only existed in CI was discovered by the tag — and a tag that fails to publish burns its version number. The gate now runs the same set, and the behavior suite (real PTY, real daemon, timing-exposed) retries twice before reporting red.
