---
"@sma1lboy/kobe": patch
"@sma1lboy/kobe-plugin-sdk": patch
---

Persist engine-native session identities as temporal EngineRuns per task tab
so structured history and Agent Trace remain attached across daemon restarts,
conversation changes, and repeated resumes. Claude Code and Codex
SessionStart hooks now preserve their native start cause; startup/resume/clear
create a Kobe run while compaction stays in the current run. The browser
consumes the current run, filters earlier turns from the same resumed session,
and never infers identity from terminal pixels or the newest transcript.
