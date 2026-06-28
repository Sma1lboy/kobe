/**
 * Pure row model for the file tree pane — extracted from `FileTree.tsx`
 * so it stays unit-testable (the component file drags in `@opentui`,
 * which vitest/node cannot load; see `index.ts`).
 *
 * The load-bearing export is {@link reconcileRows}: the Ops pane's
 * fs-watch refresh re-fetches `git ls-files` / `git status` and rebuilds
 * the row list from scratch, so every refresh used to produce ALL-NEW row
 * objects. Solid's `<For>` keys by object identity, which meant each
 * refresh destroyed and recreated every row's opentui renderables —
 * and @opentui/core 0.2.4 retains a small amount of native memory per
 * renderable create/destroy cycle (~300B; JS heap stays flat while RSS
 * climbs). A busy engine worktree refreshes thousands of times a day,
 * which is exactly the multi-GB Ops-pane growth observed in production.
 * Reconciling by row key keeps the previous object whenever its fields
 * are unchanged, so `<For>` reuses the existing renderables and the
 * native churn drops to "rows that actually changed".
 */

import { reconcileStableRows } from "@/tui/lib/stable-rows"
import { truncateStart } from "@/tui/lib/truncate"
import type { FileStatus, StatusEntry, TreeNode } from "./git"

/**
 * Internal row shape. The All tab renders a tree (files + collapsible
 * directories with `depth` for indentation). The Changes tab renders a
 * flat list of status rows carrying +/- diff stats.
 */
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

/** Flatten the visible portion of a built tree into render rows. */
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

/**
 * Truncate a path keeping its TAIL — the leaf (filename) carries the
 * meaning, so on a narrow pane we drop the leading directories and show
 * `…components/sidebar/Sidebar.tsx` rather than clipping the filename off
 * the right. Thin alias over the shared {@link truncateStart} owner, which
 * counts by code point so a surrogate pair (emoji / astral char in a
 * filename) is never bisected into a `�` replacement glyph.
 */
export function truncatePathTail(path: string, max: number): string {
  return truncateStart(path, max)
}

/** Map a status entry list to Changes-tab rows. */
export function statusRows(entries: readonly StatusEntry[]): Row[] {
  return entries.map((e) => ({
    kind: "status" as const,
    path: e.path,
    status: e.status,
    added: e.added,
    deleted: e.deleted,
  }))
}

/** Identity key for a row — kind + path is unique within one tab's list. */
function rowKey(row: Row): string {
  return `${row.kind}\u0000${row.path}`
}

/** Field-level equality between two rows of the same key. */
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

/**
 * Reconcile a freshly built row list against the previous one, preserving
 * object identity for rows whose fields are unchanged.
 *
 * - A `next` row whose key exists in `prev` with equal fields → the PREV
 *   object is returned in its place (so `<For>` reuses its renderables).
 * - When every position resolves to its previous object (same order, same
 *   length), the `prev` ARRAY itself is returned, so a memo holding the
 *   result doesn't notify downstream at all.
 */
export function reconcileRows(prev: readonly Row[], next: readonly Row[]): readonly Row[] {
  return reconcileStableRows(prev, next, rowKey, rowEquals)
}

/**
 * Content equality for the `allFiles` signal — `git ls-files` output is a
 * sorted string list, so an mtime-only touch produces an identical list
 * and the signal must not notify (otherwise the tree memo and every row
 * rebuild for nothing). Null = "not loaded"; only equal to itself.
 */
export function sameFileList(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Content equality for the `changes` signal (status + numstat rows). */
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
