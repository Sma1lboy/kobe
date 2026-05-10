/**
 * Pure state machine for the preview pane's tab list.
 *
 * Lives outside `Preview.tsx` so vitest (Node) can exercise the open/close/
 * mode-toggle semantics without instantiating the renderer. Mirrors the
 * sidebar's pattern (controller.ts) — pure logic in its own module, the
 * Solid component just observes a Solid signal that wraps these snapshots.
 *
 * Model:
 *   - Tabs are an ordered list of `Tab`s. Each tab tracks the file's
 *     repo-relative path, the desired view mode (`file` | `diff`), and a
 *     scrollTop hint so switching tabs preserves scroll position.
 *   - `activeIndex` is `[0, tabs.length - 1]` or `-1` when empty.
 *   - `open(path)` either focuses an existing tab (no-op on data) or
 *     appends a fresh one and focuses it.
 *   - `close(path)` removes the tab and tries to keep the focus on the
 *     "neighbour" tab so quick-close-and-keep-reading flows feel natural.
 *
 * Mode is per-tab — switching tabs restores whatever the user last looked
 * at on that tab. This matches editors that remember view modes per file.
 *
 * No Solid imports here. The component wraps these helpers with a
 * `createSignal` and re-renders when the snapshot ref changes.
 */

export type PreviewMode = "file" | "diff"

export type PreviewTab = {
  /** Repo-relative path. The display label is derived from this (basename). */
  readonly path: string
  /** Per-tab mode. Defaults to "file" — overridden by `setMode`. */
  readonly mode: PreviewMode
  /** Scroll position to restore on focus. Component owns the actual scrollbox. */
  readonly scrollTop: number
}

export type PreviewState = {
  readonly tabs: readonly PreviewTab[]
  readonly activeIndex: number
}

/** Initial empty state — no tabs, no active index. */
export const EMPTY_STATE: PreviewState = {
  tabs: [],
  activeIndex: -1,
}

/**
 * Find a tab's index by path. Linear scan; tab counts are typically <20
 * so a Map is overkill (and would complicate the immutable update path).
 */
export function findTabIndex(state: PreviewState, path: string): number {
  for (let i = 0; i < state.tabs.length; i++) {
    if (state.tabs[i]?.path === path) return i
  }
  return -1
}

/** Resolve the active tab, or `undefined` when the list is empty. */
export function activeTab(state: PreviewState): PreviewTab | undefined {
  if (state.activeIndex < 0) return undefined
  return state.tabs[state.activeIndex]
}

/**
 * Open a tab for `path`. If a tab with that path already exists, just
 * focus it. Otherwise append a fresh tab (default mode `defaultMode` —
 * the caller decides based on whether the file is in `git status` and
 * whether a diff base is configured). Idempotent.
 */
export function openTab(state: PreviewState, path: string, defaultMode: PreviewMode = "file"): PreviewState {
  const existing = findTabIndex(state, path)
  if (existing >= 0) {
    if (existing === state.activeIndex) return state
    return { tabs: state.tabs, activeIndex: existing }
  }
  const next: PreviewTab = { path, mode: defaultMode, scrollTop: 0 }
  return {
    tabs: [...state.tabs, next],
    activeIndex: state.tabs.length,
  }
}

/**
 * Close the tab at `path`. The active index slides:
 *   - If we closed the active tab and there's a tab to the right, take it.
 *   - Else step left.
 *   - If the list becomes empty, activeIndex returns to -1.
 */
export function closeTab(state: PreviewState, path: string): PreviewState {
  const idx = findTabIndex(state, path)
  if (idx < 0) return state
  const tabs = state.tabs.slice(0, idx).concat(state.tabs.slice(idx + 1))
  if (tabs.length === 0) return EMPTY_STATE
  let activeIndex = state.activeIndex
  if (idx === state.activeIndex) {
    // Prefer to step right (so the visual cursor moves toward newer
    // tabs, like browsers do); if we were on the last tab, step left.
    activeIndex = idx >= tabs.length ? tabs.length - 1 : idx
  } else if (idx < state.activeIndex) {
    // Closing a tab to the LEFT of the active one — shift active by -1
    // so the same tab stays focused.
    activeIndex = state.activeIndex - 1
  }
  return { tabs, activeIndex }
}

/** Step the active index by `delta` (wraps via modulo, matches dialog-diff). */
export function moveActive(state: PreviewState, delta: number): PreviewState {
  if (state.tabs.length === 0) return state
  const len = state.tabs.length
  const next = (((state.activeIndex + delta) % len) + len) % len
  if (next === state.activeIndex) return state
  return { tabs: state.tabs, activeIndex: next }
}

/** Set the mode on the currently active tab. No-op when no tab is active. */
export function setActiveMode(state: PreviewState, mode: PreviewMode): PreviewState {
  if (state.activeIndex < 0) return state
  const cur = state.tabs[state.activeIndex]
  if (!cur || cur.mode === mode) return state
  const tabs = state.tabs.slice()
  tabs[state.activeIndex] = { ...cur, mode }
  return { tabs, activeIndex: state.activeIndex }
}

/**
 * Persist the scroll offset on the active tab. The component calls this
 * whenever the user scrolls so we can restore on tab switch. Returns the
 * same state object when nothing changed (cheap stability).
 */
export function setActiveScroll(state: PreviewState, scrollTop: number): PreviewState {
  if (state.activeIndex < 0) return state
  const cur = state.tabs[state.activeIndex]
  if (!cur || cur.scrollTop === scrollTop) return state
  const tabs = state.tabs.slice()
  tabs[state.activeIndex] = { ...cur, scrollTop }
  return { tabs, activeIndex: state.activeIndex }
}

/** Display label for a tab — basename, falls back to the full path. */
export function tabLabel(tab: PreviewTab): string {
  const slash = tab.path.lastIndexOf("/")
  return slash >= 0 ? tab.path.slice(slash + 1) : tab.path
}
