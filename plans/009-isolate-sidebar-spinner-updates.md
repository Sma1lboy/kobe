# 009 — Isolate sidebar spinner updates to loading rows

- **Status**: DONE
- **Commit**: 81969596
- **Severity**: MEDIUM
- **Category**: Performance
- **Rule**: Beyond the scan
- **Estimated scope**: 4–6 files, ~120 lines

## Problem

`packages/kobe/src/tui-react/panes/sidebar/Sidebar.tsx:137` owns the 10Hz spinner frame. Every tick re-runs the complete Sidebar, rebuilds `rowCardShared` at line 365, and reconciles every project/task row even though only loading glyphs change.

## Target

Move the pulse into a small external store/context and subscribe only the animated glyph subtree. Idle rows and the Sidebar list must retain render identity across a frame tick. One acceptable shape:

```ts
const spinnerStore = createSpinnerFrameStore(SPINNER_FRAME_MS, SPINNER_TICK_CYCLE)

function LoadingGlyph(props: { active: boolean; frames: readonly string[] }) {
  const frame = useSyncExternalStore(
    props.active ? spinnerStore.subscribe : NOOP_SUBSCRIBE,
    props.active ? spinnerStore.getSnapshot : ZERO_SNAPSHOT,
  )
  return <text>{props.active ? frames[frame % frames.length] : props.frames[0]}</text>
}
```

Start the timer only while at least one visible row is loading; stop it at zero subscribers/loading rows.

## Repo conventions to follow

- Keep row-view derivation framework-free.
- Preserve reduced-motion behavior and zero timer work when all rows are idle.
- Extend deterministic operation-count budgets in `packages/kobe/test/tui/perf-budgets.test.ts`; do not assert milliseconds.

## Steps

1. Add a tiny framework-free or React-local spinner frame store with explicit start/stop lifecycle.
2. Remove `spinnerFrame` state from the Sidebar root.
3. Subscribe only the loading glyph/sweep component; idle row components must not observe frame updates.
4. Add render counters for N rows and multiple frame ticks.
5. Assert only active loading rows re-render and the timer stops after the last loading row disappears.

## Boundaries

- Do not change spinner glyphs, speed, colors, or reduced-motion output.
- Do not memoize every row blindly; isolate the changing signal first.
- Do not add a package.

## Verification

- `bun test packages/kobe/test/tui/perf-budgets.test.ts packages/kobe/test/tui/sidebar-row-view.test.ts`
- Render harness with 100 idle rows + 1 loading row: frame ticks update only the loading subtree.
- Done when Sidebar root/list commits no longer scale with task count per spinner frame.
