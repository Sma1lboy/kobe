# 007 — Keep the settings keyboard cursor visible

- **Status**: DONE
- **Commit**: 81969596
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Rule**: Beyond the scan
- **Estimated scope**: 4–6 files, ~100 lines

## Problem

`packages/kobe/src/tui-react/component/settings-dialog/index.tsx:275` moves `bodyRow` with arrows/j/k/Tab. The standalone page is wrapped by the scrollbox at `packages/kobe/src/tui-react/workspace/host.tsx:303`, but no selected row renderable is registered and no `scrollChildIntoView` call follows the cursor. On a short terminal, keyboard focus moves onto invisible controls.

## Target

Give settings rows stable renderable refs and scroll the active body row into view after selection changes, following the established Sidebar pattern at `packages/kobe/src/tui-react/panes/sidebar/Sidebar.tsx:260`:

```ts
useEffect(() => {
  const scroll = scrollRef.current
  const row = bodyRowEls.current.get(bodyRow)
  if (level === "body" && scroll && row && scroll.viewport.height > 0) {
    scroll.scrollChildIntoView(row.id)
  }
}, [level, bodyRow, section])
```

The settings surface should own its scrollbox/ref so both workspace and standalone entrypoints share behavior.

## Repo conventions to follow

- Reuse `ScrollBoxRenderable.scrollChildIntoView` and React 19 ref cleanups from Sidebar rows.
- Preserve mouse activation and existing row numbering from `settings-rows.ts`.
- Add no new keybindings; this plan only makes existing keyboard movement visible.

## Steps

1. Move or expose the settings scrollbox so `SettingsDialog` can own its ref.
2. Register each body row by its existing row index, removing refs on unmount.
3. Follow the selected body row on level/bodyRow/section changes.
4. Add a short-viewport render test that moves beyond the first viewport and asserts scrollTop changes and the cursor row appears.
5. Verify all settings sections, including dynamic engine rows and feedback editing.

## Boundaries

- No new or moved chords.
- Do not change settings values or section order.
- Do not hardcode terminal heights.

## Verification

- Focused settings render test at a short viewport.
- `bun test packages/kobe/test/tui/settings-rows.test.ts`
- Visual harness at approximately 80×20: j/k keeps the selected row visible.
- Done when no keyboard-selected settings row can remain clipped.
