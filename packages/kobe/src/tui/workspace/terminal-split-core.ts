/**
 * Pure split-tree state for ONE workspace terminal tab (issue #16) — the
 * PTY-world take on tmux panes. A tab body is a tree: leaves are PTY
 * panes, groups lay their children out `row` (side-by-side, tmux's `%`)
 * or `column` (stacked, tmux's `"`). Splitting inside a group of the
 * same orientation inserts a sibling; splitting across orientations
 * nests a new group — so arbitrary tmux-style layouts fall out of two
 * chords (`ctrl+\` split-right, `ctrl+=` split-down).
 *
 * Framework-free on purpose, same architecture as `terminal-tabs-core.ts`:
 * the Solid component (`TerminalSplit.tsx`) owns signals/rendering, this
 * module owns the transitions so vitest can pin them.
 *
 * PTY keying: the FIRST pane (`pane-1`) keeps the tab-level registry key
 * (`tabPtyKey`) so the engine session that was already running survives
 * the first split un-remounted; every later pane suffixes its own id —
 * see `paneKey`.
 */

export interface SplitLeaf {
  readonly kind: "leaf"
  /** Stable id — PTY registry key suffix. Never reused within a tab. */
  readonly id: string
  /**
   * Fixed argv this pane runs. Undefined ONLY for the tab's original
   * pane (`pane-1`), which runs whatever the tab itself runs (engine
   * command / editor command / degraded shell). Panes created by a
   * split always carry the user's shell here.
   */
  readonly command?: readonly string[]
}

export interface SplitGroup {
  readonly kind: "group"
  /** `row` = children side-by-side; `column` = children stacked. */
  readonly orientation: "row" | "column"
  /** Invariant: length ≥ 2 — transitions collapse 1-child groups away. */
  readonly children: readonly SplitNode[]
}

export type SplitNode = SplitLeaf | SplitGroup

export interface SplitState {
  readonly root: SplitNode
  /** The leaf that has keyboard focus while the tab is focused. */
  readonly activeLeafId: string
  /** Next pane ordinal to hand out (monotonic — close does not recycle). */
  readonly nextOrdinal: number
}

/** A tab's initial state: the single original pane, no groups. */
export function initialSplit(): SplitState {
  return { root: { kind: "leaf", id: "pane-1" }, activeLeafId: "pane-1", nextOrdinal: 2 }
}

/** DFS leaf order — the visual reading order (`f3` cycles through it). */
export function leaves(node: SplitNode): readonly SplitLeaf[] {
  return node.kind === "leaf" ? [node] : node.children.flatMap(leaves)
}

/**
 * Registry key for one pane's PTY. `pane-1` maps to the TAB key so the
 * PTY that existed before the first split is reused, not respawned;
 * later panes namespace under it.
 */
export function paneKey(tabKey: string, leafId: string): string {
  return leafId === "pane-1" ? tabKey : `${tabKey}::${leafId}`
}

/**
 * Split the active pane: insert a new shell pane running `command` after
 * it, laid out by `orientation`, and focus the new pane (tmux focuses
 * the split it just created). Inside a group of the same orientation the
 * new pane becomes a sibling; otherwise the active leaf is replaced by a
 * nested group of the two — this is exactly tmux's nesting behavior.
 */
export function splitActive(state: SplitState, orientation: "row" | "column", command: readonly string[]): SplitState {
  const leaf: SplitLeaf = { kind: "leaf", id: `pane-${state.nextOrdinal}`, command }
  const insert = (node: SplitNode): SplitNode => {
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
 * Remove a pane (its process exited, tmux-style auto-close): 1-child
 * groups collapse into their parent so the tree never holds degenerate
 * groups. Returns `null` when `id` is the last pane — the CALLER owns
 * what happens then (the tab-level exit behavior: degrade-to-shell or
 * close the tab). Focus moves to the previous leaf in reading order.
 */
export function removeLeaf(state: SplitState, id: string): SplitState | null {
  const all = leaves(state.root)
  if (all.length <= 1) return null
  const prune = (node: SplitNode): SplitNode | null => {
    if (node.kind === "leaf") return node.id === id ? null : node
    const children = node.children.map(prune).filter((c): c is SplitNode => c !== null)
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

/** Cycle pane focus by ±1 in reading order, wrapping (tmux `prefix o`). */
export function cycleLeaf(state: SplitState, delta: 1 | -1): SplitState {
  const order = leaves(state.root).map((l) => l.id)
  if (order.length <= 1) return state
  const i = order.indexOf(state.activeLeafId)
  const next = order[(i + delta + order.length) % order.length]
  return { ...state, activeLeafId: next }
}

/** Focus a specific pane (mouse click). No-op for unknown ids. */
export function focusLeaf(state: SplitState, id: string): SplitState {
  if (!leaves(state.root).some((l) => l.id === id)) return state
  return state.activeLeafId === id ? state : { ...state, activeLeafId: id }
}
