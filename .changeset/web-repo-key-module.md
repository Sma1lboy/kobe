---
"@sma1lboy/kobe": patch
---

Internal: the issue-snapshot repo-key aliasing — which path variants (`/repo`, `/repo/`, a worktree checkout) a snapshot is cached under — was copy-pasted in three places (the SPA store, the bridge's daemon-link mirror, and the issues hook's `normalize`), so a fix in one could silently diverge and only one copy was tested. It now lives in a single dependency-free `lib/repo-key` module (`normalizeRepoPath` + `repoSnapshotAliases`) with one test that pins the contract, consumed by all three. No behavior change.
