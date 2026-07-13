# 006 — Cache terminal passthrough bindings per mount

- **Status**: DONE
- **Commit**: 81969596
- **Severity**: MEDIUM
- **Category**: Performance
- **Rule**: Beyond the scan
- **Estimated scope**: 2–3 files, ~60 lines

## Problem

`packages/kobe/src/tui-react/panes/terminal/keys.ts:59` reconstructs the complete passthrough table on every render. The current constants produce 846 binding objects per render. `Terminal` re-renders for PTY snapshot/cursor updates, so sustained output repeatedly allocates identical key strings, objects, Set, and closure wiring.

## Target

Precompute chord strings at module scope, then build handler objects once per hook mount. Handlers read the existing latest opts ref:

```ts
const PASSTHROUGH_CHORDS = buildPassthroughChords(PASSTHROUGH_NAMES, RESERVED_GLOBAL_CHORDS)

export function useTerminalBindings(opts: TerminalBindingsOpts): void {
  const optsRef = useLatest(opts)
  const passthroughBindings = useMemo(() => {
    const forward = (evt: KeyEvent): void => {
      const bytes = keyEventToShellBytes(evt)
      if (bytes != null) optsRef.current.write(bytes)
    }
    return PASSTHROUGH_CHORDS.map((key) => ({ key, cmd: forward }))
  }, [])
  // only the three configurable Kobe bindings may be rebuilt
}
```

## Repo conventions to follow

- Keep key vocabulary in `keys-pure.ts`; React registration stays in `tui-react/.../keys.ts`.
- Reuse `useLatest` for current write/scroll/reset callbacks.
- Extend `packages/kobe/test/tui/perf-budgets.test.ts` or add a focused render test that counts table construction, not wall-clock time.

## Steps

1. Extract a pure passthrough-chord builder and test exact reserved-chord filtering.
2. Compute the 846 chord strings once at module load.
3. Memoize binding objects once per mounted hook using latest callback refs.
4. Render/update a harness repeatedly and assert the passthrough table is constructed once.
5. Confirm modal/prefix/IME tests remain green.

## Boundaries

- Do not change any chord or precedence.
- Do not move pane-local keys behind a prefix.
- Do not use wall-clock assertions.

## Verification

- `bun test packages/kobe/test/render/terminal-modal-keys.test.tsx packages/kobe/test/render/terminal-ime-keys.test.tsx packages/kobe/test/render/terminal-prefix.test.tsx`
- `bun test packages/kobe/test/tui/perf-budgets.test.ts`
- Compare allocation/build counters across 100 snapshot renders: one passthrough build per mount.
- Done when key behavior is identical and render-driven table reconstruction is eliminated.
