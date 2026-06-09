import type { TaskEngineState } from "@/client/remote-orchestrator"
import type { TaskActivityState } from "@/engine/hook-events"
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
  // No "backlog" word: every regular task is born `backlog` and nothing
  // in the live engine path ever flips it, so surfacing the literal word
  // lies (KOB). Fall back to the branch / a neutral dash instead.
  backlog: "—",
  canceled: "canceled",
  error: "error",
}

/**
 * Readable subtitle word for the non-normal engine activity states. These
 * outrank the branch in the subtitle so a rate-limited / errored / waiting
 * task spells out *why* it's stuck instead of relying on the tiny title
 * glyph alone. Normal states (`idle` / `running` / `turn_complete`) return
 * null so the row keeps showing the branch.
 */
function activityLabelFor(state: TaskActivityState | undefined): { text: string; tone: SidebarTone } | null {
  switch (state) {
    case "rate_limited":
      return { text: "rate limited", tone: "warning" }
    case "permission_needed":
      return { text: "needs permission", tone: "warning" }
    case "error":
      return { text: "error", tone: "error" }
    default:
      return null
  }
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
  const activityLabel = activityLabelFor(activityState)
  const spinner = IN_PROGRESS_SPINNER[opts.spinnerFrame] ?? IN_PROGRESS_SPINNER[0]
  const tone = activityLabel?.tone ?? (loading ? "primary" : (activityBadge?.tone ?? badge.tone))
  // Subtitle priority: a non-normal activity word (rate limited / needs
  // permission / error) outranks the branch, then the branch, then the
  // lifecycle label — which is a neutral dash for `backlog`, never the word.
  const subtitleText = activityLabel
    ? opts.truncateBranch(activityLabel.text, opts.subtitleBudget)
    : task.branch.length > 0
      ? opts.truncateBranch(task.branch, opts.subtitleBudget)
      : STATUS_LABEL[task.status]
  return {
    isMain,
    titleText: isMain ? repoBasename(task.repo) : task.title,
    subtitleText,
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
