/**
 * Pure layout policy for the tmux workspace — parsing tmux pane listings and
 * deciding which pane a new split targets. No tmux I/O lives here; everything
 * is deterministic and unit-tested in test/tui/layout-actions.test.ts.
 */

import {
  ENGINE_PANE_ROLE,
  OPS_PANE_PERCENT,
  SHELL_PANE_ROLE,
  WORKSPACE_AUX_PANE_ROLE,
  WORKSPACE_SPLIT_MAX_PANES,
  clampPanePercent,
} from "@/tmux/session-layout"

export type LayoutPaneRow = {
  readonly paneId: string
  readonly role: string
  readonly active: boolean
  readonly paneWidth: number
  readonly paneHeight: number
  readonly windowWidth: number
  readonly windowHeight: number
}

export const ACTIVE_WINDOW_LAYOUT_FORMAT =
  "#{pane_id}\t#{@kobe_role}\t#{pane_active}\t#{pane_width}\t#{pane_height}\t#{window_width}\t#{window_height}"

export function parseLayoutPaneRows(stdout: string): LayoutPaneRow[] {
  const rows: LayoutPaneRow[] = []
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const [paneId, role, active, paneWidth, paneHeight, windowWidth, windowHeight] = line.split("\t")
    if (!paneId) continue
    const width = Number.parseInt(paneWidth ?? "", 10)
    const height = Number.parseInt(paneHeight ?? "", 10)
    const winW = Number.parseInt(windowWidth ?? "", 10)
    const winH = Number.parseInt(windowHeight ?? "", 10)
    rows.push({
      paneId: paneId.trim(),
      role: role?.trim() ?? "",
      active: active?.trim() === "1",
      paneWidth: Number.isFinite(width) ? width : 0,
      paneHeight: Number.isFinite(height) ? height : 0,
      windowWidth: Number.isFinite(winW) ? winW : 0,
      windowHeight: Number.isFinite(winH) ? winH : 0,
    })
  }
  return rows
}

export type WorkspaceSplitPlan =
  | { readonly kind: "split"; readonly targetPane: string; readonly direction: "-h" | "-v" }
  | { readonly kind: "maxed" }
  | { readonly kind: "missing-engine" }

/**
 * Natural templates for 1→4 middle panes:
 *   2 panes: split engine horizontally.
 *   3 panes: split the first aux vertically, creating a right-side stack.
 *   4 panes: split engine vertically, yielding a 2x2 grid.
 */
export function planWorkspaceSplit(rows: readonly LayoutPaneRow[]): WorkspaceSplitPlan {
  const engine = rows.find((row) => row.role === ENGINE_PANE_ROLE)
  if (!engine) return { kind: "missing-engine" }
  const aux = rows.filter((row) => row.role === WORKSPACE_AUX_PANE_ROLE)
  if (aux.length + 1 >= WORKSPACE_SPLIT_MAX_PANES) return { kind: "maxed" }
  if (aux.length === 0) return { kind: "split", targetPane: engine.paneId, direction: "-h" }
  if (aux.length === 1) return { kind: "split", targetPane: aux[0]?.paneId ?? engine.paneId, direction: "-v" }
  return { kind: "split", targetPane: engine.paneId, direction: "-v" }
}

export function resolveShellPane(rows: readonly LayoutPaneRow[]): LayoutPaneRow | undefined {
  return rows.find((row) => row.role === SHELL_PANE_ROLE) ?? rows.find((row) => row.role === "")
}

export function expandedTerminalHeightPercent(rawOpsHeightPercent?: number): number {
  const opsPct = clampPanePercent(rawOpsHeightPercent ?? Number.NaN) ?? OPS_PANE_PERCENT
  return 100 - opsPct
}
