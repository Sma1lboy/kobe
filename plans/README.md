# PureTUI React improvement plans

Audit base: `81969596` (`0.8.2` release commit). Source changes are intentionally absent at plan creation time.

| Order | Plan | Severity | Status | Depends on |
| --- | --- | --- | --- | --- |
| 1 | [001 Sanitize terminal notifications](001-sanitize-terminal-notifications.md) | HIGH | DONE | — |
| 2 | [002 Clear PTY state on switch](002-clear-pty-state-on-switch.md) | HIGH | DONE | — |
| 3 | [005 Validate terminal reset target](005-validate-terminal-reset-target.md) | HIGH | DONE | — |
| 4 | [004 Last-intent task activation](004-make-task-activation-last-intent-wins.md) | HIGH | DONE | — |
| 5 | [003 Guard async workspace actions](003-guard-async-workspace-actions.md) | HIGH | DONE | — |
| 6 | [006 Cache terminal passthrough bindings](006-cache-terminal-passthrough-bindings.md) | MEDIUM | DONE | — |
| 7 | [007 Follow settings keyboard cursor](007-follow-settings-keyboard-cursor.md) | MEDIUM | DONE | — |
| 8 | [008 Help keyboard scrolling](008-add-help-keyboard-scrolling.md) | MEDIUM | TODO | owner chord approval if needed |
| 9 | [009 Isolate sidebar spinner updates](009-isolate-sidebar-spinner-updates.md) | MEDIUM | TODO | operation-count baseline |
| 10 | [010 Split TerminalTabs ownership](010-split-terminal-tabs-ownership.md) | MEDIUM | TODO | correctness changes settled |

## Execution policy

- Work directly on `main` only because the owner explicitly requested it in the `/loop` invocation.
- Complete and verify one coherent batch before the next: security, terminal correctness, async workspace correctness, accessibility/performance, architecture.
- Add patch changesets for user-visible fixes. Combine notes only when one commit intentionally ships a single behavior group.
- Stage only named files; preserve unrelated `.codex/` and landing-page assets.
- After each batch, run focused tests and then the relevant repository gate. Final pass runs React Doctor changed scope, lint, typecheck, full tests, build, behavior, and the real OpenTUI harness.
