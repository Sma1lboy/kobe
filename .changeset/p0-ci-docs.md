---
"@sma1lboy/kobe": patch
---

Close CI/release gate gaps: PR and release workflows now run the full `bun run test` suite (fast + unix-socket daemon tests, previously excluded by a hardcoded directory whitelist), and `release.sh`/`release.yml` gate on lint + typecheck + test + behavior before a version is ever tagged or published.
