---
"@sma1lboy/kobe": patch
---

perf: the daemon's transcript-activity probe walks each worktree's transcript dir once per tick, not twice.

Each ~1.5s tick used to make two independent directory listings of the same on-disk transcript store per local worktree — `latestTranscriptMtime` (a readdir + stats, or a full `~/.codex/sessions` date-tree walk) then the turn detector's `latestCompletion` (another walk). The detector already finds the newest file's mtime while locating the latest completion, so it now surfaces both from a single scan (`latestActivity`), and the probe drops the redundant mtime call for claude/codex — one listing per probe, half the stats — while copilot/custom engines keep their single existing walk. The published activity facts (mtime/completionId/completionAt) are byte-identical.
