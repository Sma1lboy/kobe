/**
 * Pane focus signal — kept slim now that tmux owns cross-pane focus.
 *
 * Pre-sprint-7 the in-process app rendered a 5-pane layout and routed
 * cross-pane focus via this context (PANE_ORDER + cycle + blur on
 * transition). tmux now drives pane focus directly (Alt+h/j/k/l →
 * `select-pane`, see `src/tmux/keybindings.ts`), so this context only
 * tracks focus WITHIN a single rendering surface — e.g. input vs. list
 * inside one pane subprocess, or the fallback page that mounts in the
 * non-tmux branch of `startApp`.
 *
 * The PaneId union is kept four-wide because the still-shipping pane
 * rendering components (`src/tui/panes/sidebar/`, `panes/filetree/`,
 * etc.) declare their `focused` prop as `is("sidebar")` and friends.
 * The context just has no `cycle` anymore.
 */

import { type Accessor, type JSXElement, createContext, createSignal, useContext } from "solid-js"

/**
 * Logical pane ids. tmux owns cross-pane focus today, so these names
 * are local to whichever rendering surface mounts this context.
 */
export type PaneId = "sidebar" | "workspace" | "files" | "terminal"

export type FocusContextValue = {
  focused: Accessor<PaneId>
  is: (pane: PaneId) => Accessor<boolean>
  setFocused: (pane: PaneId) => void
  /** Increments on every `setFocused` call — input renderables that
   * want to reassert native focus on each focus event track this. */
  refocusTick: Accessor<number>
}

const FocusContext = createContext<FocusContextValue | null>(null)

export function FocusProvider(props: { children: JSXElement; initial?: PaneId }): JSXElement {
  const [focused, setFocusedSignal] = createSignal<PaneId>(props.initial ?? "sidebar")
  const [refocusTick, setRefocusTick] = createSignal(0)

  function setFocused(pane: PaneId): void {
    setRefocusTick((t) => t + 1)
    if (focused() === pane) return
    setFocusedSignal(pane)
  }

  const accessorCache = new Map<PaneId, Accessor<boolean>>()
  function is(pane: PaneId): Accessor<boolean> {
    let acc = accessorCache.get(pane)
    if (!acc) {
      acc = () => focused() === pane
      accessorCache.set(pane, acc)
    }
    return acc
  }

  const value: FocusContextValue = { focused, is, setFocused, refocusTick }
  return <FocusContext.Provider value={value}>{props.children}</FocusContext.Provider>
}

export function useFocus(): FocusContextValue {
  const ctx = useContext(FocusContext)
  if (!ctx) {
    throw new Error("useFocus: must be called inside <FocusProvider>. See src/tui/context/focus.tsx.")
  }
  return ctx
}
