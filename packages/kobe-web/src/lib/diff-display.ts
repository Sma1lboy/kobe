import type { DiffRow } from "./diff-rows.ts"

export function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "added":
      return { label: "A", cls: "text-kobe-green" }
    case "untracked":
      return { label: "U", cls: "text-kobe-green" }
    case "modified":
      return { label: "M", cls: "text-kobe-yellow" }
    case "deleted":
      return { label: "D", cls: "text-kobe-red" }
    case "renamed":
      return { label: "R", cls: "text-kobe-blue" }
    case "copied":
      return { label: "C", cls: "text-kobe-blue" }
    default:
      return {
        label: status.slice(0, 1).toUpperCase() || "?",
        cls: "text-muted",
      }
  }
}

export function rowClass(kind: DiffRow["kind"]): string {
  switch (kind) {
    case "hunk":
      return "kobe-diff-hunk"
    case "meta":
      return "kobe-diff-meta"
    case "add":
      return "kobe-diff-add"
    case "del":
      return "kobe-diff-del"
    default:
      return "kobe-diff-ctx"
  }
}
