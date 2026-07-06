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
 */
export function splitActive<T>(state: SplitState<T>, orientation: "row" | "column", content: T): SplitState<T> {
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
  return { root: insert(state.root), activeLeafId: leaf.id, nextOrdinal: state.nextOrdinal + 1 }
}

/**
 * Remove a leaf (its content finished, tmux-style auto-close): 1-child
 * groups collapse into their parent so the tree never holds degenerate
 * groups. Returns `null` when `id` is the last leaf — the CALLER owns
 * what happens then (e.g. the terminal tab's own exit behavior). Focus
 * moves to the previous leaf in reading order.
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
  const fallback = order[Math.max(0, order.indexOf(id) - 1)]
  const activeLeafId = state.activeLeafId === id ? fallback : state.activeLeafId
  return { ...state, root, activeLeafId }
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
