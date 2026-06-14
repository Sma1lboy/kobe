/**
 * tab-kinds — the single registry of workspace tab kinds.
 *
 * A tab's kind drives two cross-cutting facts that were previously string-matched
 * in many places: whether it owns a server-side PTY (so closing or pruning the
 * tab must tear that PTY down) and how a fresh tab of the kind is titled. Both
 * lived as scattered `kind === "vendor" || kind === "terminal"` guards (three
 * copies) and count-based title strings spread across five tab-mutation helpers.
 * They live here now, so adding or changing a kind is one registry entry and the
 * rules are unit-tested in isolation.
 *
 * Pure + React-free: the per-kind RENDER (a component) stays in WorkspaceTabs'
 * type-narrowing switch, where the discriminated union keeps it type-safe — a
 * render dispatch table would trade that safety for indirection. This registry
 * owns the DATA about a kind, not its UI.
 */

export type WorkspaceTabKind =
  | "empty"
  | "vendor"
  | "terminal"
  | "transcript"
  | "file"

/** How a fresh tab of a kind is titled. */
type TitleMode =
  /** `${label} N`, where N = (existing tabs of this kind) + 1. */
  | "count"
  /** the fixed label. */
  | "static"
  /** the caller supplies the title (file: derived from its path). */
  | "derived"

interface TabKindSpec {
  /** Owns a server-side PTY — closing/pruning the tab must close that PTY. */
  readonly hasPty: boolean
  readonly titleMode: TitleMode
  readonly label: string
}

export const TAB_KINDS: Record<WorkspaceTabKind, TabKindSpec> = {
  empty: { hasPty: false, titleMode: "static", label: "New tab" },
  vendor: { hasPty: true, titleMode: "count", label: "Vendor" },
  terminal: { hasPty: true, titleMode: "count", label: "Terminal" },
  transcript: { hasPty: false, titleMode: "static", label: "Chat" },
  file: { hasPty: false, titleMode: "derived", label: "File" },
}

/**
 * Does a tab of this kind own a server-side PTY that must be torn down when the
 * tab is closed or its task pruned? Replaces the scattered
 * `kind === "vendor" || kind === "terminal"` guards.
 */
export function tabHasPty(kind: WorkspaceTabKind): boolean {
  return TAB_KINDS[kind].hasPty
}

/**
 * The title for a fresh tab of `kind`, given the task's existing tabs (for the
 * per-kind count). `derived`-titled kinds (file) return their bare label — the
 * caller titles those from their own data (e.g. the file basename).
 */
export function nextTabTitle(
  kind: WorkspaceTabKind,
  existing: readonly { kind: WorkspaceTabKind }[],
): string {
  const spec = TAB_KINDS[kind]
  if (spec.titleMode === "count") {
    const n = existing.filter((tab) => tab.kind === kind).length + 1
    return `${spec.label} ${n}`
  }
  return spec.label
}
