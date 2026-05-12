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

import { useRenderer } from "@opentui/solid"
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
  /**
   * Increments on every `setFocused` call — even when the pane signal
   * didn't change. Pane-internal inputs that want to re-assert native
   * focus on every focus event (e.g. the chat composer's textarea
   * when the user re-clicks the workspace pane or switches chat tabs
   * while workspace was already focused) track this in their focus
   * effect so they refocus reliably even without a pane transition.
   */
  refocusTick: Accessor<number>
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
  const [refocusTick, setRefocusTick] = createSignal(0)
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
  function setFocused(pane: PaneId): void {
    // Always tick — even when the pane signal won't change. Same-pane
    // setFocused calls happen when the user clicks the chat tab strip,
    // re-clicks inside the workspace pane, or switches between chat
    // tabs while workspace was already focused. The chat composer's
    // textarea may have lost native focus to a child renderable in the
    // meantime (a MessageList box click, a tab chip), and the tick is
    // the signal it tracks to re-grab focus. Without this, the focus
    // mirror only fired on cross-pane transitions and the textarea
    // would silently stop receiving keystrokes inside workspace.
    setRefocusTick((t) => t + 1)
    if (focused() === pane) return
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
  const accessorCache = new Map<PaneId, Accessor<boolean>>()
  function is(pane: PaneId): Accessor<boolean> {
    let acc = accessorCache.get(pane)
    if (!acc) {
      acc = () => focused() === pane
      accessorCache.set(pane, acc)
    }
    return acc
  }

  const value: FocusContextValue = { focused, is, setFocused, cycle, refocusTick }
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
