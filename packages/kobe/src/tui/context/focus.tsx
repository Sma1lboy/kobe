/**
 * Pane focus — global, single source of truth.
 *
 * Two-tier focus model (vim-windows style):
 *
 *   - **`focused` pane** = which pane is *selected* — its border
 *     highlights, navigation chords (ctrl+hjkl, tab) cycle here. The
 *     pane is visible, but its inputs do NOT capture keystrokes.
 *   - **`mode = "engaged"`** = the selected pane has *taken the keyboard*.
 *     Chat composer's textarea grabs native opentui focus; terminal
 *     pane forwards every byte to the PTY child. Nav chords (ctrl+hjkl /
 *     tab) are disabled while engaged so the user can't accidentally
 *     leave mid-typing.
 *
 * All four panes share the same select/engaged distinction. Even
 * sidebar/files have it — without it, their pane-local bare-letter
 * bindings (j/k/d/r/a, 1/2/3) would still fire while the user is
 * trying to navigate, defeating the whole point of select mode. The
 * cost is one extra `enter` press to start nav-ing in the new pane,
 * paid for by complete keyboard predictability.
 *
 * Cold boot is the one exception: the initial pane lands in `engaged`
 * so first-time users can immediately press j/k on the task list
 * without having to discover the "press enter to interact" rule.
 *
 * Transitions:
 *   - `setFocused(pane)` defaults mode to "select". Pass
 *     `{ engage: true }` to land engaged immediately (used by mouse
 *     click and business flows like task creation / selection).
 *   - `engage()` flips mode to "engaged". Wired to `enter` in select
 *     mode.
 *   - `disengage()` flips back to "select". Wired to `esc`.
 *
 * Why a context (not just lifted signals in `Shell`):
 *
 *   - The signal is read by ~6 panes + the StatusBar + ~3 keybinding
 *     groups. Threading a prop through every level was getting messy
 *     and easy to forget on new panes.
 *   - Mouse-driven focus changes happen on pane wrappers in app.tsx
 *     itself — having the setter in context means the wrapper code can
 *     just call into the context without app.tsx growing more closures.
 *
 * The context only owns focus. Other global state (composer drafts,
 * task selection, etc.) stays where it is — focus is special because
 * keybinding gating depends on it everywhere.
 */

import { useRenderer } from "@opentui/solid"
import { type Accessor, type JSXElement, createContext, createSignal, useContext } from "solid-js"

/** The four primary panes in kobe's layout. */
export type PaneId = "sidebar" | "workspace" | "files" | "terminal"

/**
 * Focus mode. Applies to all four panes: select gates pane-local
 * keybindings off (so global nav chord don't get eaten); engaged
 * turns them on.
 */
export type FocusMode = "select" | "engaged"

/** Cycle order — used by `tab` / `shift+tab`. */
export const PANE_ORDER = ["sidebar", "workspace", "files", "terminal"] as const satisfies readonly PaneId[]

export type FocusContextValue = {
  /** Reactive read of the currently focused pane. */
  focused: Accessor<PaneId>
  /** Reactive read of the current mode (select | engaged). */
  mode: Accessor<FocusMode>
  /** Boolean accessor — `useFocus().is("sidebar")()` is true when sidebar is focused. */
  is: (pane: PaneId) => Accessor<boolean>
  /** Boolean accessor — true when `pane` is focused AND mode is "engaged". */
  isEngaged: (pane: PaneId) => Accessor<boolean>
  /**
   * Set the focused pane. Defaults to mode "select" — the user has
   * to press enter to engage and start using pane-local bindings.
   *
   * Pass `{ engage: true }` to land in engaged mode immediately —
   * used by mouse clicks, task creation/selection, file open, and
   * other business flows where the intent is "the user is now driving
   * this pane". Keyboard-driven pane jumps (ctrl+hjkl, tab) skip the
   * flag so the user lands in select and can decide whether to engage.
   */
  setFocused: (pane: PaneId, opts?: { engage?: boolean }) => void
  /** Switch the currently focused pane to engaged mode. */
  engage: () => void
  /** Switch the currently focused pane back to select mode. */
  disengage: () => void
  /** Cycle by ±1 through PANE_ORDER. Used by `tab` / `shift+tab`. */
  cycle: (delta: 1 | -1) => void
}

const FocusContext = createContext<FocusContextValue | null>(null)

/**
 * Mount the focus state at the top of the tree. Default focused pane is
 * `sidebar`: on cold boot there's no task selected, so the chat composer
 * has nothing to do; the sidebar's task list IS the natural starting
 * point. Once the user creates / selects a task, `setFocusedPane`
 * transitions automatically (see `app.tsx` Shell). Single-letter global
 * shortcuts (`?`, `n`, `q`) work out of the box because the composer
 * isn't claiming keys at boot.
 */
export function FocusProvider(props: { children: JSXElement; initial?: PaneId }): JSXElement {
  const [focused, setFocusedSignal] = createSignal<PaneId>(props.initial ?? "sidebar")
  // Cold boot lands engaged so first-time users can immediately press
  // j/k on the sidebar without having to discover the "enter to engage"
  // rule. Subsequent keyboard pane jumps use setFocused without the
  // engage flag and land in select.
  const [mode, setModeSignal] = createSignal<FocusMode>("engaged")
  const renderer = useRenderer()

  /**
   * Unified focus-change entry point. ALL pane focus changes go
   * through this:
   *
   *   1. Update the reactive `focused` signal (downstream pane
   *      gates and the Composer's textarea-mirror createEffect
   *      pick up the change).
   *   2. Blur whatever opentui renderable was holding native focus.
   *      Without this, the chat composer's textarea would keep
   *      eating keystrokes when the user pressed ctrl+q (or any
   *      ctrl+hjkl) to leave workspace — Composer's mirror effect
   *      WOULD eventually call `ref.blur()`, but the timing left
   *      a one-tick window where the textarea still owned input
   *      focus. Doing the blur here removes that race entirely.
   *      When the workspace is re-focused, Composer's createEffect
   *      reasserts focus on its textarea ref.
   *
   * The blur is unconditional — it covers every pane the user
   * might leave (terminal pane's renderable, future input-bearing
   * panes). Panes that don't grab opentui native focus (sidebar,
   * files — they manage cursor state in Solid signals) are
   * unaffected.
   */
  function setFocused(pane: PaneId, opts?: { engage?: boolean }): void {
    // Business flows (click, task select, etc.) sometimes call
    // setFocused on the same pane to "ensure engaged" — handle that
    // even when the pane signal doesn't change.
    if (focused() === pane) {
      if (opts?.engage && mode() !== "engaged") {
        setModeSignal("engaged")
      }
      return
    }
    const current = renderer?.currentFocusedRenderable
    if (current && !current.isDestroyed) {
      try {
        current.blur()
      } catch {
        // best-effort; if blur throws (renderable in a bad state)
        // we still want the pane focus signal to flip.
      }
    }
    setFocusedSignal(pane)
    // Default mode after a pane jump is "select". Business flows opt
    // into "engaged" via { engage: true } when the intent is "drive
    // this pane immediately" (mouse click, task creation, etc.).
    setModeSignal(opts?.engage ? "engaged" : "select")
  }

  function engage(): void {
    setModeSignal("engaged")
  }

  function disengage(): void {
    setModeSignal("select")
  }

  function cycle(delta: 1 | -1): void {
    const idx = PANE_ORDER.indexOf(focused())
    const next = (idx + delta + PANE_ORDER.length) % PANE_ORDER.length
    setFocused(PANE_ORDER[next] as PaneId)
  }

  // Memoize per-pane `is(pane)` accessors so consumers can pass them
  // through reactive `focused?: Accessor<boolean>` props without
  // creating a fresh function each render (would defeat memoization
  // downstream).
  const isCache = new Map<PaneId, Accessor<boolean>>()
  function is(pane: PaneId): Accessor<boolean> {
    let acc = isCache.get(pane)
    if (!acc) {
      acc = () => focused() === pane
      isCache.set(pane, acc)
    }
    return acc
  }

  // Same memoization for isEngaged accessors.
  const engagedCache = new Map<PaneId, Accessor<boolean>>()
  function isEngaged(pane: PaneId): Accessor<boolean> {
    let acc = engagedCache.get(pane)
    if (!acc) {
      acc = () => focused() === pane && mode() === "engaged"
      engagedCache.set(pane, acc)
    }
    return acc
  }

  const value: FocusContextValue = {
    focused,
    mode,
    is,
    isEngaged,
    setFocused,
    engage,
    disengage,
    cycle,
  }
  return <FocusContext.Provider value={value}>{props.children}</FocusContext.Provider>
}

/**
 * Read the focus context. Throws if called outside `<FocusProvider>` —
 * that's almost always a bug, so we fail loud rather than fall back to
 * a no-op default.
 */
export function useFocus(): FocusContextValue {
  const ctx = useContext(FocusContext)
  if (!ctx) {
    throw new Error("useFocus: must be called inside <FocusProvider>. See src/tui/context/focus.tsx.")
  }
  return ctx
}
