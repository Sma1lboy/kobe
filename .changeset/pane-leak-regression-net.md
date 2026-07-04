---
"@sma1lboy/kobe": patch
---

test: pin the #205 orphaned-pane-process regression + add a `kobe doctor` resource snapshot

- `test/behavior/pane-cleanup.test.ts` boots a real kobe session, runs `kobe kill-sessions` (the command `kobe reset`/`dev:sandbox:reset` also call), and asserts every pane's full process group is gone after the exit grace — not just the pane leader, since an engine CLI that ignores SIGHUP (real `claude` does) survives as an orphaned child of an already-dead leader. Verified against a temporary revert of the `termAllPaneGroups()` sweep: the test fails and catches the leaked pid, then passes again with the fix restored.
- The shared behavior-test fake `claude` shim (`test/behavior/harness.ts`) now ignores SIGHUP like the real CLI does, so this and future behavior tests exercise the same "engine survives HUP" path production hits.
- `kobe doctor` gains a `resources:` section (`src/cli/doctor-resources.ts`): kobe pane-process count + RSS grouped by command, so a future memory report comes with hard numbers instead of "eventually had to kill bun manually".

No behavior change to the shipped CLI beyond the new `kobe doctor` section.
