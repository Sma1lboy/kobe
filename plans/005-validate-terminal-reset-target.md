# 005 — Validate the terminal reset target after confirmation

- **Status**: TODO
- **Commit**: 81969596
- **Severity**: HIGH
- **Category**: Bugs & correctness
- **Rule**: Beyond the scan
- **Estimated scope**: 2–3 files, ~50 lines

## Problem

`packages/kobe/src/tui-react/panes/terminal/Terminal.tsx:224` attempts to guard a delayed reset:

```ts
const taskIdAtClick = props.taskId
void DialogConfirm.show(...).then((ok) => {
  if (props.taskId !== taskIdAtClick || props.cwd !== cwdAtClick) return
  forceReacquire(cwdAtClick, taskIdAtClick, geometryAtClick)
})
```

The callback captures `props` from the same render, so the comparison is invariant. It also remains true after unmount.

## Target

Read latest identity and mounted state when the promise resolves:

```ts
const identityRef = useLatest({ taskId: props.taskId, cwd: props.cwd })
const mountedRef = useRef(true)
useEffect(() => () => { mountedRef.current = false }, [])

// after confirm
const current = identityRef.current
if (!mountedRef.current || current.taskId !== taskIdAtClick || current.cwd !== cwdAtClick) return
forceReacquire(cwdAtClick, taskIdAtClick, geometryAtClick)
```

## Repo conventions to follow

- Reuse `useLatest`; do not add a new latest-value hook.
- Extend terminal render/dialog tests, using a deferred confirmation promise.
- Reset remains confirmation-gated and keeps click-time geometry.

## Steps

1. Add latest identity and mounted refs.
2. Replace captured-props comparison with commit-time ref reads.
3. Test task switch before confirm resolution.
4. Test unmount before confirm resolution.
5. Assert `registry.reset` is not called in either stale case.

## Boundaries

- Do not change the F5 binding.
- Do not change reset command/session semantics.
- Do not suppress reset for an unchanged mounted terminal.

## Verification

- Focused Terminal reset tests.
- `bun --filter @sma1lboy/kobe typecheck`
- Manual: open reset confirm, switch tasks, confirm; neither old nor new terminal resets.
- Done when only the still-mounted click-time terminal can reset.
