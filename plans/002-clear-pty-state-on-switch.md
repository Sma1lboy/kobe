# 002 — Clear stale PTY state on switch

- **Status**: DONE
- **Resolution**: Reopened after adversarial review confirmed the real tab-switch path can retain the old snapshot; successful acquire now clears snapshot/cursor before exposing the replacement PTY.
- **Commit**: 81969596
- **Severity**: HIGH
- **Category**: Bugs & correctness
- **Rule**: Beyond the scan
- **Estimated scope**: 2–3 files, ~50 lines

## Problem

`packages/kobe/src/tui-react/panes/terminal/use-terminal-pty.ts:111` replaces the PTY without clearing the previous render state:

```ts
setAcquireError(null)
setPty(handle)
onFreshPtyRef.current()
```

The subscription only replaces the snapshot when capture is non-empty:

```ts
const initial = pty.capture()
if (initial.length > 0) setSnapshot(initial)
```

An empty fresh shell therefore displays the previous task/tab transcript until it emits output.

## Target

Reset PTY-owned render state atomically before exposing the new handle:

```ts
setAcquireError(null)
setSnapshot([])
setCursor(null)
setExited(handle.killed)
setPty(handle)
onFreshPtyRef.current()
```

The subscription may then prime non-empty cached content normally.

## Repo conventions to follow

- Match the existing reset path at `use-terminal-pty.ts:159`, which already clears snapshot and cursor.
- Add a focused hook/render regression near `packages/kobe/test/render/terminal-pane.test.tsx` or a small extracted state-transition test if the hook harness cannot inject two PTYs cleanly.
- Use an injectable registry seam already accepted by `useTerminalPty`; do not touch the global production registry in tests.

## Steps

1. Clear snapshot, cursor, and exited state when acquire succeeds for a different PTY identity.
2. Preserve cached capture priming for non-empty PTYs.
3. Test switching from a PTY with visible rows to a fresh PTY whose capture is empty.
4. Assert no frame contains the old rows after the switch.
5. Add a patch changeset unless grouped with plans 003–005 in one correctness release.

## Boundaries

- Do not kill or reset either PTY.
- Do not alter scrollback storage or registry ownership.
- Preserve acquire failure behavior.

## Verification

- Focused terminal render/hook test.
- `bun --filter @sma1lboy/kobe typecheck`
- Visual harness: switch between a noisy task and a fresh shell; no old transcript flashes.
- Done when an empty new PTY immediately renders empty state.
