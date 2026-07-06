import type { TaskEngineState, TaskJobState } from "@/client/remote-orchestrator"
import type { TaskActivityState } from "@/engine/hook-events"
import { t } from "@/tui/i18n"
import type { Task, TaskStatus } from "@/types/task"
import { isBuiltinVendor } from "@/types/vendor"
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

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "done":
      return t("tasks.status.done")
    case "in_review":
      return t("tasks.status.inReview")
    case "in_progress":
      return t("tasks.status.working")
    case "backlog":
      return t("tasks.status.backlog")
    case "canceled":
      return t("tasks.status.canceled")
    case "error":
      return t("tasks.status.error")
  }
}

function activityLabelFor(state: TaskActivityState | undefined): { text: string; tone: SidebarTone } | null {
  switch (state) {
    case "rate_limited":
      return { text: t("tasks.activity.rateLimited"), tone: "warning" }
    case "permission_needed":
      return { text: t("tasks.activity.permissionNeeded"), tone: "warning" }
    case "error":
      return { text: t("tasks.activity.error"), tone: "error" }
    default:
      return null
  }
}

export const IN_PROGRESS_SPINNER: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export const SPINNER_FRAME_MS = 100

export function prCheckChip(task: Task): { glyph: string; tone: SidebarTone } | null {
  switch (task.prStatus?.checkState) {
    case "passing":
      return { glyph: "✓", tone: "success" }
    case "failing":
      return { glyph: "✗", tone: "error" }
    case "pending":
      return { glyph: "•", tone: "warning" }
    default:
      return null
  }
}

const NO_TRACKING_GLYPH = "·"

function noTrackingSubtitle(): string {
  return t("tasks.subtitle.noTracking")
}

function materializingSubtitle(): string {
  return t("tasks.subtitle.materializing")
}

function isCustomEngineTask(task: Task): boolean {
  if (task.kind === "main") return false
  return task.vendor !== undefined && !isBuiltinVendor(task.vendor)
}

export function buildSidebarRowView(opts: {
  readonly task: Task
  readonly activity?: TaskEngineState
  readonly job?: TaskJobState
  readonly live: boolean
  readonly spinnerFrame: number
  readonly subtitleBudget: number
  readonly truncateBranch: (branch: string, budget: number) => string
  readonly mainBranch?: string
}): SidebarRowView {
  const { task } = opts
  const isMain = task.kind === "main"
  const branch = isMain ? (opts.mainBranch ?? "") : task.branch
  const badge = STATUS_BADGE[task.status]
  const activityState = opts.activity?.state
  const hasActivity = activityState !== undefined
  const activityBadge = activityBadgeFor(activityState)
  const activityLabel = activityLabelFor(activityState)
  const untrackedCustomEngine = isCustomEngineTask(task) && !hasActivity
  const materializing = opts.job !== undefined
  const loading =
    materializing ||
    (!untrackedCustomEngine &&
      (activityState === "running" || opts.live || (!hasActivity && !isMain && task.status === "in_progress")))
  const spinner = IN_PROGRESS_SPINNER[opts.spinnerFrame] ?? IN_PROGRESS_SPINNER[0]
  const tone = materializing
    ? "primary"
    : untrackedCustomEngine
      ? "textMuted"
      : (activityLabel?.tone ?? (loading ? "primary" : (activityBadge?.tone ?? badge.tone)))
  const fallbackSubtitle = untrackedCustomEngine ? noTrackingSubtitle() : statusLabel(task.status)
  const subtitleText = materializing
    ? opts.truncateBranch(materializingSubtitle(), opts.subtitleBudget)
    : activityLabel
      ? opts.truncateBranch(activityLabel.text, opts.subtitleBudget)
      : branch.length > 0
        ? opts.truncateBranch(branch, opts.subtitleBudget)
        : opts.truncateBranch(fallbackSubtitle, opts.subtitleBudget)
  const restGlyph = untrackedCustomEngine ? NO_TRACKING_GLYPH : (activityBadge?.glyph ?? badge.glyph)
  const restProjectGlyph = untrackedCustomEngine ? NO_TRACKING_GLYPH : (activityBadge?.glyph ?? "★")
  return {
    isMain,
    titleText: isMain ? repoBasename(task.repo) : task.title,
    subtitleText,
    loading,
    stateGlyph: loading ? spinner : restGlyph,
    projectGlyph: loading ? spinner : restProjectGlyph,
    tone,
  }
}

export function withSpinnerFrame(view: SidebarRowView, frame: () => number): SidebarRowView {
  if (!view.loading) return view
  const spinner = IN_PROGRESS_SPINNER[frame() % IN_PROGRESS_SPINNER.length] ?? "⠋"
  if (spinner === view.stateGlyph && spinner === view.projectGlyph) return view
  return { ...view, stateGlyph: spinner, projectGlyph: spinner }
}

function activityBadgeFor(
  state: TaskActivityState | undefined,
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
