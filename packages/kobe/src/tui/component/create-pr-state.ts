import type { TaskPRStatus } from "../../types/task.ts"

export type PRChipDescription = {
  readonly key: string
  readonly label: string
  readonly tone: "normal" | "accent" | "warning" | "error"
}

export function shouldPollPRStatus(status: TaskPRStatus | undefined): boolean {
  if (status?.provider !== "github") return false
  return status.lifecycle === "creating" || status.lifecycle === "open" || status.lifecycle === "unknown"
}

export function describePRChip(status: TaskPRStatus | undefined): PRChipDescription {
  if (!status || status.provider !== "github") return { key: "[PR]", label: "Create PR", tone: "normal" }
  if (status.lifecycle === "ready_to_merge") return { key: "[Merge]", label: "Ready to merge", tone: "accent" }
  if (status.lifecycle === "merged") return { key: "[PR]", label: "Merged", tone: "accent" }
  if (status.lifecycle === "closed") return { key: "[PR]", label: "Closed", tone: "normal" }
  if (status.lifecycle === "creating") return { key: "[PR]", label: "Finding PR", tone: "warning" }
  if (status.checkState === "pending") return { key: "[PR]", label: "CI pending", tone: "warning" }
  if (status.checkState === "failing") return { key: "[PR]", label: "CI failing", tone: "error" }
  return { key: "[PR]", label: "PR open", tone: "normal" }
}
