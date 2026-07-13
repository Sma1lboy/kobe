# 008 — Add keyboard scrolling to Help

- **Status**: TODO
- **Commit**: 81969596
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Rule**: Beyond the scan
- **Estimated scope**: 2 files, ~60 lines

## Problem

`packages/kobe/src/tui-react/component/help-dialog.tsx:43` binds only `?` while the content lives in a scrollbox at line 64. Mouse-wheel users can reach lower shortcuts; keyboard-only users cannot.

## Target

Keep a `ScrollBoxRenderable` ref and register navigation using existing, already-owned help-dialog keys only if they do not collide with documented global bindings. Prefer arrows/PageUp/PageDown/Home/End and direct scroll methods:

```ts
const scrollRef = useRef<ScrollBoxRenderable | null>(null)
const scrollBy = (delta: number) => {
  const scroll = scrollRef.current
  if (!scroll) return
  scroll.scrollTo({ x: 0, y: Math.max(0, scroll.scrollTop + delta) })
}
```

Before implementation, verify the exact chord placement against `docs/KEYBINDINGS.md`; because this introduces dialog-local chords, record owner approval if the chosen keys are not already the platform's native scroll vocabulary.

## Repo conventions to follow

- Imitate imperative scrolling in `packages/kobe/src/tui-react/panes/filetree/FileTree.tsx:388`.
- Extend `packages/kobe/test/render/help-dialog.test.tsx`.
- Keep `?`/Esc close behavior and modal isolation.

## Steps

1. Add the scrollbox ref.
2. Add keyboard scroll handlers for the approved native navigation keys.
3. Clamp the top; let ScrollBoxRenderable clamp the lower bound, or derive its max from content/viewport if required.
4. Test at a short viewport: PageDown changes visible content, PageUp returns, close keys still work.
5. Update `docs/KEYBINDINGS.md` only if these keys constitute new Kobe-owned chords.

## Boundaries

- Do not change help grouping or copy.
- Do not shadow prefix/global actions outside the modal.
- No user-visible text changes unless all locales are updated.

## Verification

- `bun test packages/kobe/test/render/help-dialog.test.tsx`
- Visual harness at short height using keyboard only.
- Done when every help row is reachable without a pointer and modal key isolation remains green.
