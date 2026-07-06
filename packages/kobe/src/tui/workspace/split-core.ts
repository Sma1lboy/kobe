export interface SplitLeaf<T> {
  readonly kind: "leaf"
  readonly id: string
  readonly content: T
}

export interface SplitGroup<T> {
  readonly kind: "group"
  readonly orientation: "row" | "column"
  readonly children: readonly SplitNode<T>[]
}

export type SplitNode<T> = SplitLeaf<T> | SplitGroup<T>

export interface SplitState<T> {
  readonly root: SplitNode<T>
  readonly activeLeafId: string
  readonly nextOrdinal: number
}

export function initialSplit<T>(content: T): SplitState<T> {
  return { root: { kind: "leaf", id: "leaf-1", content }, activeLeafId: "leaf-1", nextOrdinal: 2 }
}

export function leaves<T>(node: SplitNode<T>): readonly SplitLeaf<T>[] {
  return node.kind === "leaf" ? [node] : node.children.flatMap(leaves)
}

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
  if (root === null) return null
  if (leaves(root).length === all.length) return state
  const order = all.map((l) => l.id)
  const fallback = order[Math.max(0, order.indexOf(id) - 1)]
  const activeLeafId = state.activeLeafId === id ? fallback : state.activeLeafId
  return { ...state, root, activeLeafId }
}

export function cycleLeaf<T>(state: SplitState<T>, delta: 1 | -1): SplitState<T> {
  const order = leaves(state.root).map((l) => l.id)
  if (order.length <= 1) return state
  const i = order.indexOf(state.activeLeafId)
  const next = order[(i + delta + order.length) % order.length]
  return { ...state, activeLeafId: next }
}

export function focusLeaf<T>(state: SplitState<T>, id: string): SplitState<T> {
  if (!leaves(state.root).some((l) => l.id === id)) return state
  return state.activeLeafId === id ? state : { ...state, activeLeafId: id }
}
