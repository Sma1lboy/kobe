/**
 * Narrow-layout breakpoint (issue #14 — phone SSH, ~46×70 cells).
 *
 * Below NARROW_BREAKPOINT cols the workspace collapses to a single-panel
 * layout (sidebar ⇄ workspace mutually exclusive, footer condensed). At or
 * above it the desktop three-pane layout must be byte-identical — issue
 * #11's golden stubs anchor that behavior, so every narrow consumer gates
 * on this one predicate rather than inventing its own threshold.
 *
 * Consumers derive the flag per render from `useTerminalDimensions().width`
 * — opentui re-renders on terminal resize, so the flag is live.
 */
export const NARROW_BREAKPOINT = 70

/** True when the terminal is too narrow for the three-pane desktop layout. */
export function isNarrowWidth(cols: number): boolean {
  return cols < NARROW_BREAKPOINT
}

export type NarrowSurface = "sidebar" | "content"

/**
 * Which single surface the narrow layout renders — sidebar and workspace
 * are mutually exclusive full-screen views below the breakpoint.
 *
 * Sidebar focus always means the list (ctrl+q's existing "back to the
 * sidebar" semantic IS the back gesture — no new chord). Otherwise the
 * content shows whenever there is something to show: a selected task's
 * workspace, or an open rail page (kanban/automations/issues, which move
 * focus into the content pane on open). With neither, fall back to the
 * sidebar — the content pane would only say "no task".
 */
export function narrowSurface(args: {
  focusedPane: string
  hasSelection: boolean
  hasOpenPage: boolean
}): NarrowSurface {
  if (args.focusedPane === "sidebar") return "sidebar"
  return args.hasSelection || args.hasOpenPage ? "content" : "sidebar"
}
