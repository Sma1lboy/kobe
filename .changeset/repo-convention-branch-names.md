---
"@sma1lboy/rove": patch
---

Auto branch names now follow the target repo's own naming convention instead of `rove/<slug>-<id>`: Rove scans existing local + origin branches to infer the dominant style (type prefixes like `feat/`/`fix/` or bare kebab slugs), applies it to the title-derived slug, and resolves collisions with short `-2`/`-3` suffixes. Generated names never contain rove/kobe branding; empty repos fall back to a bare kebab slug. Explicit `--branch` and `set-branch` are unchanged, and existing branches are never renamed.
