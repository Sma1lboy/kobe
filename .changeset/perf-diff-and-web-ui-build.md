---
"@sma1lboy/kobe": patch
---

Two build/serve perf fixes. The `dist/web-ui` build output is now emptied before the fresh web bundle is copied in — vite hashes bundle filenames per build, so old `index-<hash>.js`/`.css` generations were accumulating in the published npm tarball forever; the tarball now carries only the current build's assets. The `/api/diff` route no longer spawns `git diff --no-index` one-at-a-time per untracked file (a worktree of newly scaffolded files made the Changes rail and file preview multi-second loads); untracked patches now run through a bounded worker pool (≤8 concurrent), so a repo with hundreds of untracked files can't fork-bomb git. The diff response payload is unchanged.
