/**
 * Sidebar layout preference (Settings → General).
 *
 *   - `tree` — project → worktree → tab, with tabs as rows and no
 *     horizontal strip (owner call 2026-08-01). Each worktree's state is
 *     visible and managed on its own.
 *   - `flat` — the two-section PROJECTS / TASKS list this replaced.
 *
 * A preference rather than a hard swap while the tree settles: the flat
 * sidebar is a working surface with years of muscle memory behind it, and
 * a one-key way back costs one boolean.
 *
 * kv-persisted; read live by `tui-react/workspace/host.tsx`.
 */

export const SIDEBAR_MODE_KEY = "sidebar.mode"

export type SidebarMode = "tree" | "flat"

export const DEFAULT_SIDEBAR_MODE: SidebarMode = "tree"

export function resolveSidebarMode(stored: unknown): SidebarMode {
  return stored === "flat" || stored === "tree" ? stored : DEFAULT_SIDEBAR_MODE
}
