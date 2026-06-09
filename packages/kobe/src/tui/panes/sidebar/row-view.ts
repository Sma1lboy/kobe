import type { TaskEngineState } from "@/client/remote-orchestrator"
import type { Task, TaskStatus } from "@/types/task"
import { repoBasename } from "./groups"

export type SidebarTone = "success" | "warning" | "primary" | "textMuted" | "error"

export interface SidebarRowView {
  readonly isMain: boolean
  readonly titleText: string
  readonly subtitleText: string
  readonly loading: boolean
  readonly stateGlyph: string
  readonly projectGlyph: string
  readonly tone: SidebarTone
}

const STATUS_BADGE: Record<TaskStatus, { glyph: string; tone: SidebarTone }> = {
  done: { glyph: "✓", tone: "success" },
  in_review: { glyph: "◐", tone: "warning" },
  in_progress: { glyph: "", tone: "primary" },
  backlog: { glyph: "○", tone: "textMuted" },
  canceled: { glyph: "⊘", tone: "textMuted" },
  error: { glyph: "✕", tone: "error" },
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  done: "done",
  in_review: "in review",
  in_progress: "working",
  backlog: "backlog",
  canceled: "canceled",
  error: "error",
}

export const IN_PROGRESS_SPINNER: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export const SPINNER_FRAME_MS = 100

export function buildSidebarRowView(opts: {
  readonly task: Task
  readonly activity?: TaskEngineState
  readonly live: boolean
  readonly spinnerFrame: number
  readonly subtitleBudget: number
  readonly truncateBranch: (branch: string, budget: number) => string
}): SidebarRowView {
  const { task } = opts
  const isMain = task.kind === "main"
  const badge = STATUS_BADGE[task.status]
  const activityState = opts.activity?.state
  const hasActivity = activityState !== undefined
  const loading = activityState === "running" || opts.live || (!hasActivity && !isMain && task.status === "in_progress")
  const activityBadge = activityBadgeFor(activityState)
  const spinner = IN_PROGRESS_SPINNER[opts.spinnerFrame] ?? IN_PROGRESS_SPINNER[0]
  const tone = loading ? "primary" : (activityBadge?.tone ?? badge.tone)
  return {
    isMain,
    titleText: isMain ? repoBasename(task.repo) : task.title,
    subtitleText:
      task.branch.length > 0 ? opts.truncateBranch(task.branch, opts.subtitleBudget) : STATUS_LABEL[task.status],
    loading,
    stateGlyph: loading ? spinner : (activityBadge?.glyph ?? badge.glyph),
    projectGlyph: loading ? spinner : (activityBadge?.glyph ?? "★"),
    tone,
  }
}

function activityBadgeFor(
  state: TaskEngineState["state"] | undefined,
): { glyph: string; tone: "primary" | "warning" | "error" } | null {
  switch (state) {
    case "rate_limited":
      return { glyph: "◷", tone: "warning" }
    case "permission_needed":
      return { glyph: "?", tone: "warning" }
    case "error":
      return { glyph: "✕", tone: "error" }
    case "turn_complete":
      return { glyph: "✓", tone: "primary" }
    default:
      return null
  }
}
