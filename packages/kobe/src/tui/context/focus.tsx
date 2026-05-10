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
 * Sidebar / files don't have an "engaged" concept (no input fields):
 * focusing them auto-sets mode = "engaged" since j/k/d/r/a etc. are
 * the only keys that make sense there. So the mode signal is really
 * only meaningful when `focused === "workspace"` or `"terminal"`.
 *
 * Transitions:
 *   - `setFocused(pane)` resets mode: workspace/terminal → "select";
 *     sidebar/files → "engaged".
 *   - `engage()` flips mode to "engaged" (for workspace/terminal). Wired
 *     to `enter` in select mode and to "open new chat" / "select task"
 *     business flows so the user lands in the input directly.
 *   - `disengage()` flips back to "select". Wired to `esc` so the user
 *     can navigate without leaving the pane.
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
 * Focus mode. Only meaningful when the focused pane is workspace or
 * terminal (the two panes that have input fields). For sidebar / files,
 * the mode is implicitly "engaged" — those panes don't have a "type
 * into me" sub-state.
 */
export type FocusMode = "select" | "engaged"

/** Cycle order — used by `tab` / `shift+tab`. */
export const PANE_ORDER = ["sidebar", "workspace", "files", "terminal"] as const satisfies readonly PaneId[]

/** Panes that own input and therefore have a meaningful select/engaged mode. */
const INPUT_PANES: ReadonlySet<PaneId> = new Set(["workspace", "terminal"])

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
   * Set the focused pane. Resets mode based on the destination:
   * workspace/terminal land in "select" by default (user must press
   * enter to engage); sidebar/files always land in "engaged" since
   * they have no select/engaged distinction.
   *
   * Pass `{ engage: true }` to land in engaged mode immediately —
   * used by business flows that mean "the user is now driving this
   * pane", e.g. clicking a chat tab, creating a task, mouse-clicking
   * the workspace pane. Keyboard-driven pane jumps (ctrl+hjkl, tab)
   * deliberately don't pass the flag so the user lands in select
   * mode and can decide whether to engage.
   */
  setFocused: (pane: PaneId, opts?: { engage?: boolean }) => void
  /**
   * Switch to engaged mode for the currently focused pane. No-op if
   * focused on sidebar/files (already implicitly engaged).
   */
  engage: () => void
  /**
   * Switch back to select mode for the currently focused pane. No-op
   * if focused on sidebar/files (no select state to enter).
   */
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
  // Initial mode follows the same rule as setFocused: input panes start
  // in "select", non-input panes start in "engaged".
  const [mode, setModeSignal] = createSignal<FocusMode>(
    INPUT_PANES.has(props.initial ?? "sidebar") ? "select" : "engaged",
  )
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
      if (opts?.engage && INPUT_PANES.has(pane) && mode() !== "engaged") {
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
    // Mode reset:
    //   sidebar / files → always "engaged" (no separate select state)
    //   workspace / terminal → "select" by default; "engaged" if
    //     business flow requested it via opts.engage.
    if (!INPUT_PANES.has(pane)) {
      setModeSignal("engaged")
    } else {
      setModeSignal(opts?.engage ? "engaged" : "select")
    }
  }

  function engage(): void {
    if (INPUT_PANES.has(focused())) {
      setModeSignal("engaged")
    }
    // sidebar / files: no-op, already engaged-equivalent.
  }

  function disengage(): void {
    if (INPUT_PANES.has(focused())) {
      setModeSignal("select")
    }
    // sidebar / files: no-op, no select state to enter.
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
