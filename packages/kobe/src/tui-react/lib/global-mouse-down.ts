/**
 * "Was there a click ANYWHERE?" — one renderer-root mouse-down listener,
 * shared by every surface that dismisses itself on an outside click.
 *
 * opentui bubbles a mouse event up the renderable chain until someone calls
 * `stopPropagation`, so the root sees every press the app didn't swallow.
 * Nothing in the TUI stops the DOWN phase (the panes' guards all sit on
 * `onMouseUp`), which makes root-level down the one signal that means "the
 * user just pressed somewhere else" without every pane having to report it.
 *
 * A surface that must NOT self-dismiss on its own press stops the down event
 * itself (see `ui/context-menu.tsx`) — that keeps "is this press mine?" a
 * hit-test opentui already answers, instead of geometry every subscriber
 * would have to recompute.
 *
 * Framework-free on purpose: the React face is `use-global-mouse-down.ts`.
 */

/** The slice of a renderable this module touches — a structural type so the
 *  core stays testable with a plain object (and independent of opentui's
 *  setter-only accessor typing). */
export interface MouseDownHost {
  onMouseDown: ((event: unknown) => void) | undefined
}

const subscribers = new Set<(event: unknown) => void>()
let installedHost: MouseDownHost | null = null

function dispatch(event: unknown): void {
  // Copy: a handler may unsubscribe itself (dismiss → unmount) mid-dispatch.
  for (const handler of [...subscribers]) handler(event)
}

/**
 * Subscribe to every mouse-down that reaches `host`. Returns the unsubscribe.
 * The listener is installed with the first subscriber and removed with the
 * last, so an app with nothing dismissable up pays nothing.
 */
export function subscribeGlobalMouseDown(host: MouseDownHost, handler: (event: unknown) => void): () => void {
  subscribers.add(handler)
  // Re-point on a host swap (a test harness builds a fresh renderer per test):
  // the old root is torn down, and its listener would never fire again.
  if (installedHost !== host) {
    if (installedHost) installedHost.onMouseDown = undefined
    installedHost = host
    host.onMouseDown = dispatch
  }
  return () => {
    subscribers.delete(handler)
    if (subscribers.size === 0 && installedHost) {
      installedHost.onMouseDown = undefined
      installedHost = null
    }
  }
}
