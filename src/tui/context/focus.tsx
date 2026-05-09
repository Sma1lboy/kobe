/**
 * Pane focus — global, single source of truth.
 *
 * The Shell wraps everything in `<FocusProvider>` so that:
 *
 *   1. Pane wrappers can call `useFocus().setFocused("sidebar")` from an
 *      `onMouseUp` handler — clicking any pane focuses it without a
 *      manual prop chain.
 *   2. Each pane reads `useFocus().is("sidebar")` to gate its own
 *      keybindings so j/k/enter/etc. only fire when that pane is the
 *      active one.
 *   3. Global single-letter shortcuts (`?`, `n`, `q`) gate on
 *      `useFocus().is("workspace") === false` — when the chat composer
 *      is the active input the user must be able to type `?` or `n` as
 *      literal characters. Ctrl-modified shortcuts (`ctrl+1`..`ctrl+4`,
 *      `ctrl+n`) bypass the input regardless and stay always-on.
 *
 * Why a context (not just lifted signals in `Shell`):
 *
 *   - The signal is read by ~6 panes + the StatusBar + ~3 keybinding
 *     groups. Threading a prop through every level was getting messy
 *     and easy to forget on new panes.
 *   - Mouse-driven focus changes happen on pane wrappers in app.tsx
 *     itself — having the setter in context means the wrapper code can
 *     just call into the context without app.tsx growing more closures.
 *   - Future panes (Wave 4: PR button, checks, etc.) get focus support
 *     "for free" by reading the context.
 *
 * The context only owns focus. Other global state (composer drafts,
 * task selection, etc.) stays where it is — focus is special because
 * keybinding gating depends on it everywhere.
 */

import { type Accessor, type JSXElement, createContext, createSignal, useContext } from "solid-js"

/** The four primary panes in kobe's layout. */
export type PaneId = "sidebar" | "workspace" | "files" | "terminal"

/** Cycle order — used by `tab` / `shift+tab`. */
export const PANE_ORDER = ["sidebar", "workspace", "files", "terminal"] as const satisfies readonly PaneId[]

export type FocusContextValue = {
  /** Reactive read of the currently focused pane. */
  focused: Accessor<PaneId>
  /** Boolean accessor — `useFocus().is("sidebar")()` is true when sidebar is focused. */
  is: (pane: PaneId) => Accessor<boolean>
  /** Set the focused pane. */
  setFocused: (pane: PaneId) => void
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
  const [focused, setFocused] = createSignal<PaneId>(props.initial ?? "sidebar")

  function cycle(delta: 1 | -1): void {
    const idx = PANE_ORDER.indexOf(focused())
    const next = (idx + delta + PANE_ORDER.length) % PANE_ORDER.length
    setFocused(PANE_ORDER[next] as PaneId)
  }

  // Memoize per-pane `is(pane)` accessors so consumers can pass them
  // through reactive `focused?: Accessor<boolean>` props without
  // creating a fresh function each render (would defeat memoization
  // downstream).
  const accessorCache = new Map<PaneId, Accessor<boolean>>()
  function is(pane: PaneId): Accessor<boolean> {
    let acc = accessorCache.get(pane)
    if (!acc) {
      acc = () => focused() === pane
      accessorCache.set(pane, acc)
    }
    return acc
  }

  const value: FocusContextValue = { focused, is, setFocused, cycle }
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
