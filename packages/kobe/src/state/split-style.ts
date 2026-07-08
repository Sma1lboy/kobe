/**
 * Split-pane appearance preference (Settings → General → Appearance).
 *
 * `box` (default) draws a full frame around every split leaf — the pane
 * reads as a card, matching the workspace's bordered columns. `line` is
 * the tmux-style minimal look: each leaf draws only the single edge it
 * shares with its previous sibling.
 *
 * kv-persisted; read live by `tui-react/workspace/TerminalSplit.tsx`.
 */

export const SPLIT_STYLE_KEY = "appearance.splitStyle"

export type SplitStyle = "box" | "line"

export const DEFAULT_SPLIT_STYLE: SplitStyle = "box"

export const SPLIT_STYLES: readonly SplitStyle[] = ["box", "line"]

/** Coerce a persisted value to a valid style (unknown → default). */
export function normalizeSplitStyle(value: unknown): SplitStyle {
  return value === "line" || value === "box" ? value : DEFAULT_SPLIT_STYLE
}
