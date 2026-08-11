/**
 * Pure, CONTENT-AGNOSTIC split-tree state for one workspace surface
 * (issue #16) — the tmux-pane layout idea, generic over what a leaf
 * shows. Leaves carry an opaque `content` payload (today: a terminal
 * command, see `TerminalSplit.tsx`; later: any workspace surface);
 * groups lay their children out `row` (side-by-side, tmux's `%`) or
 * `column` (stacked, tmux's `"`). Splitting inside a group of the same
 * orientation inserts a sibling; splitting across orientations nests a
 * new group — arbitrary tmux-style layouts fall out of two chords.
 *
 * Framework-free on purpose, same architecture as `terminal-tabs-core.ts`:
 * the Solid renderer owns signals/UI, this module owns the transitions
 * so vitest can pin them. Nothing in here may know about terminals,
 * PTYs, or engines — content-specific keying (e.g. `splitLeafPtyKey`)
 * lives with the content adapter.
 */

export interface SplitLeaf<T> {
  readonly kind: "leaf"
  /** Stable id — content adapters key their resources off it. Never
   *  reused within one split tree. The FIRST leaf is always `leaf-1`. */
  readonly id: string
  /** Opaque payload — what this leaf displays. Owned by the adapter. */
  readonly content: T
  /** User-set display name. Absent/null = the adapter's default name
   *  (owner semantics 2026-07-06: the TAB is the "group"; every leaf
   *  inside carries its own name, tab-title naming-flow style). */
  readonly title?: string | null
}

export interface SplitGroup<T> {
  readonly kind: "group"
  /** `row` = children side-by-side; `column` = children stacked. */
  readonly orientation: "row" | "column"
  /** Invariant: length ≥ 2 — transitions collapse 1-child groups away. */
  readonly children: readonly SplitNode<T>[]
}

export type SplitNode<T> = SplitLeaf<T> | SplitGroup<T>

export interface SplitState<T> {
  readonly root: SplitNode<T>
  /** The leaf that has keyboard focus while the surface is focused. */
  readonly activeLeafId: string
  /** Next leaf ordinal to hand out (monotonic — close does not recycle). */
  readonly nextOrdinal: number
}

/** FALLBACK max group-nesting depth, used only when the caller cannot
 *  supply the active leaf's rendered size (tests, headless). With a real
 *  size, `splitFits` replaces this entirely: how deep you can nest is
 *  decided by the screen, not a fixed count. */
export const MAX_SPLIT_DEPTH = 4

/** Minimum usable pane size in cells. A split whose predicted panes would
 *  fall below this is rejected — the caller keeps its fallback (chord
 *  no-ops, pane-open falls back to a tab). The cols floor matches the
 *  render clamp in `use-terminal-geometry`; rows sits above its 4-row
 *  clamp so a pane never renders pinned at the degenerate minimum. */
export const MIN_PANE_COLS = 20
export const MIN_PANE_ROWS = 6

function depth<T>(node: SplitNode<T>): number {
  return node.kind === "leaf" ? 0 : 1 + Math.max(...node.children.map(depth))
}

/** Same-orientation direct-sibling count of the active leaf — mirrors
 *  `splitActive`'s insert rule: only a leaf sitting directly in a group of
 *  the requested orientation gains a sibling; anywhere else it nests (1). */
function siblingCount<T>(root: SplitNode<T>, id: string, orientation: "row" | "column"): number {
  const find = (node: SplitNode<T>): number | null => {
    if (node.kind === "leaf") return null
    if (node.orientation === orientation && node.children.some((c) => c.kind === "leaf" && c.id === id)) {
      return node.children.length
    }
    for (const child of node.children) {
      const n = find(child)
      if (n !== null) return n
    }
    return null
  }
  return find(root) ?? 1
}

/**
 * Whether splitting the active leaf leaves every resulting pane at or above
 * `MIN_PANE_COLS`×`MIN_PANE_ROWS`, judged from the active leaf's CURRENT
 * rendered size. Even-flex prediction: a sibling insert re-divides the
 * group's extent (≈ n × the active leaf's, all children `flexGrow=1
 * flexBasis=0`) among n+1 children; a nesting split halves the leaf. One
 * cell is charged for the new divider edge. Existing siblings shrink to the
 * same predicted extent, so checking it covers them too.
 */
export function splitFits<T>(
  state: SplitState<T>,
  orientation: "row" | "column",
  activeSize: { cols: number; rows: number },
): boolean {
  const extent = orientation === "row" ? activeSize.cols : activeSize.rows
  const min = orientation === "row" ? MIN_PANE_COLS : MIN_PANE_ROWS
  const n = siblingCount(state.root, state.activeLeafId, orientation)
  return Math.floor((extent * n) / (n + 1)) - 1 >= min
}

/** The initial state: a single leaf (`leaf-1`) showing `content`. */
export function initialSplit<T>(content: T): SplitState<T> {
  return { root: { kind: "leaf", id: "leaf-1", content }, activeLeafId: "leaf-1", nextOrdinal: 2 }
}

/** DFS leaf order — the visual reading order (focus cycling follows it). */
export function leaves<T>(node: SplitNode<T>): readonly SplitLeaf<T>[] {
  return node.kind === "leaf" ? [node] : node.children.flatMap(leaves)
}

/**
 * Split the active leaf: insert a new leaf showing `content` after it,
 * laid out by `orientation`, and focus the new leaf (tmux focuses the
 * split it just created). Inside a group of the same orientation the
 * new leaf becomes a sibling; otherwise the active leaf is replaced by
 * a nested group of the two — exactly tmux's nesting behavior.
 *
 * Gating: with `activeSize` (the active leaf's current rendered cells) the
 * split is a no-op when `splitFits` predicts a pane below the minimum —
 * screen size decides, not nesting count. Without it (tests, headless) the
 * `MAX_SPLIT_DEPTH` fallback applies.
 */
export function splitActive<T>(
  state: SplitState<T>,
  orientation: "row" | "column",
  content: T,
  activeSize?: { cols: number; rows: number } | null,
): SplitState<T> {
  if (activeSize && !splitFits(state, orientation, activeSize)) return state
  const leaf: SplitLeaf<T> = { kind: "leaf", id: `leaf-${state.nextOrdinal}`, content }
  const insert = (node: SplitNode<T>): SplitNode<T> => {
    if (node.kind === "leaf") {
      if (node.id !== state.activeLeafId) return node
      return { kind: "group", orientation, children: [node, leaf] }
    }
    if (node.orientation === orientation) {
      const i = node.children.findIndex((c) => c.kind === "leaf" && c.id === state.activeLeafId)
      if (i >= 0) {
        const children = [...node.children.slice(0, i + 1), leaf, ...node.children.slice(i + 1)]
        return { ...node, children }
      }
    }
    return { ...node, children: node.children.map(insert) }
  }
  const root = insert(state.root)
  if (!activeSize && depth(root) > MAX_SPLIT_DEPTH) return state
  return { root, activeLeafId: leaf.id, nextOrdinal: state.nextOrdinal + 1 }
}

/**
 * Remove a leaf (its content finished, tmux-style auto-close): 1-child
 * groups collapse into their parent so the tree never holds degenerate
 * groups. Returns `null` when `id` is the last leaf — the CALLER owns
 * what happens then (e.g. the terminal tab's own exit behavior). When the
 * removed leaf held focus, focus moves to the previous leaf in reading
 * order — or the next one when the FIRST leaf was the one removed (there
 * is no previous), never to the just-pruned id.
 */
export function removeLeaf<T>(state: SplitState<T>, id: string): SplitState<T> | null {
  const all = leaves(state.root)
  if (all.length <= 1) return null
  const prune = (node: SplitNode<T>): SplitNode<T> | null => {
    if (node.kind === "leaf") return node.id === id ? null : node
    const children = node.children.map(prune).filter((c): c is SplitNode<T> => c !== null)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]
    return { ...node, children }
  }
  const root = prune(state.root)
  if (root === null) return null // unreachable behind the length guard; keeps prune's type honest
  if (leaves(root).length === all.length) return state // id not present — no-op
  const order = all.map((l) => l.id)
  // `order` is the reading order BEFORE removal, so `order[removedIdx]` is the
  // leaf being pruned. Step to the previous surviving leaf; when the first leaf
  // (index 0) was removed there is no previous, so take the next one — never the
  // just-pruned id. `all.length >= 2` (length guard) means index 1 always exists.
  const removedIdx = order.indexOf(id)
  const fallback = order[removedIdx > 0 ? removedIdx - 1 : removedIdx + 1]
  const activeLeafId = state.activeLeafId === id ? fallback : state.activeLeafId
  return { ...state, root, activeLeafId }
}

/**
 * Rename a leaf — empty/whitespace titles clear back to the adapter's
 * default name, same semantics as `renameActiveTab`. Unknown ids no-op.
 */
export function renameLeaf<T>(state: SplitState<T>, id: string, title: string): SplitState<T> {
  const trimmed = title.trim()
  const next = trimmed.length > 0 ? trimmed : null
  const walk = (node: SplitNode<T>): SplitNode<T> =>
    node.kind === "leaf"
      ? node.id === id
        ? { ...node, title: next }
        : node
      : { ...node, children: node.children.map(walk) }
  if (!leaves(state.root).some((l) => l.id === id)) return state
  return { ...state, root: walk(state.root) }
}

/** Cycle leaf focus by ±1 in reading order, wrapping (tmux `prefix o`). */
export function cycleLeaf<T>(state: SplitState<T>, delta: 1 | -1): SplitState<T> {
  const order = leaves(state.root).map((l) => l.id)
  if (order.length <= 1) return state
  const i = order.indexOf(state.activeLeafId)
  const next = order[(i + delta + order.length) % order.length]
  return { ...state, activeLeafId: next }
}

/** Focus a specific leaf (mouse click). No-op for unknown ids. */
export function focusLeaf<T>(state: SplitState<T>, id: string): SplitState<T> {
  if (!leaves(state.root).some((l) => l.id === id)) return state
  return state.activeLeafId === id ? state : { ...state, activeLeafId: id }
}
