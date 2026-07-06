import { reconcileStableRows } from "@/tui/lib/stable-rows"
import { truncateStart } from "@/tui/lib/truncate"
import type { FileStatus, StatusEntry, TreeNode } from "./git"

export type Row =
  | { kind: "file"; path: string; name: string; depth: number }
  | { kind: "dir"; path: string; name: string; depth: number; expanded: boolean; hasChildren: boolean }
  | {
      kind: "status"
      path: string
      status: FileStatus
      added: number | null | undefined
      deleted: number | null | undefined
    }

export function flattenTree(node: TreeNode, expanded: ReadonlySet<string>, depth: number, out: Row[]): void {
  for (const child of node.children) {
    if (child.isDir) {
      const isOpen = expanded.has(child.path)
      out.push({
        kind: "dir",
        path: child.path,
        name: child.name,
        depth,
        expanded: isOpen,
        hasChildren: child.children.length > 0,
      })
      if (isOpen) flattenTree(child, expanded, depth + 1, out)
    } else {
      out.push({ kind: "file", path: child.path, name: child.name, depth })
    }
  }
}

export function truncatePathTail(path: string, max: number): string {
  return truncateStart(path, max)
}

export function statusRows(entries: readonly StatusEntry[]): Row[] {
  return entries.map((e) => ({
    kind: "status" as const,
    path: e.path,
    status: e.status,
    added: e.added,
    deleted: e.deleted,
  }))
}

function rowKey(row: Row): string {
  return `${row.kind}\u0000${row.path}`
}

function rowEquals(a: Row, b: Row): boolean {
  if (a.kind !== b.kind || a.path !== b.path) return false
  switch (a.kind) {
    case "file": {
      const o = b as Extract<Row, { kind: "file" }>
      return a.name === o.name && a.depth === o.depth
    }
    case "dir": {
      const o = b as Extract<Row, { kind: "dir" }>
      return a.name === o.name && a.depth === o.depth && a.expanded === o.expanded && a.hasChildren === o.hasChildren
    }
    case "status": {
      const o = b as Extract<Row, { kind: "status" }>
      return a.status === o.status && a.added === o.added && a.deleted === o.deleted
    }
  }
}

export function reconcileRows(prev: readonly Row[], next: readonly Row[]): readonly Row[] {
  return reconcileStableRows(prev, next, rowKey, rowEquals)
}

export function sameFileList(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function sameStatusEntries(a: StatusEntry[] | null, b: StatusEntry[] | null): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as StatusEntry
    const y = b[i] as StatusEntry
    if (x.path !== y.path || x.status !== y.status || x.added !== y.added || x.deleted !== y.deleted) return false
  }
  return true
}
