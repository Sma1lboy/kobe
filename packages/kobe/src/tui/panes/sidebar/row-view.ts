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

/**
 * Returns a localised subtitle label for the given task status. Called at
 * render time (inside buildSidebarRowView) so `t()` is always scoped to a
 * reactive context — never frozen at module load.
 */
function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "done":
      return t("tasks.status.done")
    case "in_review":
      return t("tasks.status.inReview")
    case "in_progress":
      return t("tasks.status.working")
    case "backlog":
      // No "backlog" word: every regular task is born `backlog` and nothing
      // in the live engine path ever flips it, so surfacing the literal word
      // lies (KOB). Fall back to the branch / a neutral dash instead.
      return t("tasks.status.backlog")
    case "canceled":
      return t("tasks.status.canceled")
    case "error":
      return t("tasks.status.error")
  }
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

/**
 * The right-stuck PR-check chip for a task's subtitle row. The
 * daemon's pr-status poller writes `task.prStatus`; this maps its `checkState`
 * to a single coloured glyph (✓ passing / ✗ failing / • pending). Returns null
 * for tasks with no PR or no checks configured (`none` / `unknown`) so the row
 * stays clean. Pure — unit-tested.
 */
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

/**
 * Static dim glyph for a custom-engine task with no live signal. A custom
 * engine has no transcript store the monitor can watch (see
 * `monitor/activity.ts`), so its activity badge would otherwise sit on the
 * perpetual spinner / empty backlog dot and read as "stuck". We show a
 * neutral filled dot instead — present, but explicitly NOT animating.
 */
const NO_TRACKING_GLYPH = "·"

/**
 * Muted subtitle shown when a custom-engine task has nothing else to say.
 * Called at render time so `t()` is reactive.
 */
function noTrackingSubtitle(): string {
  return t("tasks.subtitle.noTracking")
}

/**
 * Subtitle word while a long daemon job runs for the task (today: the
 * `ensureWorktree` `git worktree add`, minute-class on a huge repo). The
 * word + spinner replace the branch — there IS no branch on disk yet while
 * the worktree materialises, so "materializing" is the honest row state.
 * Called at render time so `t()` is reactive.
 */
function materializingSubtitle(): string {
  return t("tasks.subtitle.materializing")
}

/**
 * True when this task runs on a user-added (custom) engine, which has no
 * transcript store for the activity monitor to read — so liveness simply
 * isn't tracked. A missing vendor normalizes to the built-in default
 * ({@link DEFAULT_TASK_VENDOR}), so `undefined` is NOT custom. `main` tasks
 * never carry a real engine session, so they're excluded.
 */
function isCustomEngineTask(task: Task): boolean {
  if (task.kind === "main") return false
  return task.vendor !== undefined && !isBuiltinVendor(task.vendor)
}

export function buildSidebarRowView(opts: {
  readonly task: Task
  readonly activity?: TaskEngineState
  /**
   * A long daemon operation in flight for this task, from the orchestrator's
   * `task.jobs` map (today: `ensureWorktree`). Presence means "running" —
   * the row spins with a "materializing" subtitle, in EVERY attached pane,
   * for the whole minutes-long `git worktree add` on a huge repo. Outranks
   * the other signals: the worktree doesn't exist yet, so engine activity /
   * branch labels can't be more current than this.
   */
  readonly job?: TaskJobState
  readonly live: boolean
  readonly spinnerFrame: number
  readonly subtitleBudget: number
  readonly truncateBranch: (branch: string, budget: number) => string
  /**
   * The repo root's current branch, for a `main` (project) row — its
   * `task.branch` is always `""`, so the sidebar resolves the checked-out
   * branch separately and passes it here so a project's two-line card shows
   * `main` / `feat/x` on line 2 like a task does.
   */
  readonly mainBranch?: string
}): SidebarRowView {
  const { task } = opts
  const isMain = task.kind === "main"
  // Regular tasks store their branch; a `main` row's branch lives in the repo
  // root checkout, resolved by the caller and passed as `mainBranch`.
  const branch = isMain ? (opts.mainBranch ?? "") : task.branch
  const badge = STATUS_BADGE[task.status]
  const activityState = opts.activity?.state
  const hasActivity = activityState !== undefined
  const activityBadge = activityBadgeFor(activityState)
  const activityLabel = activityLabelFor(activityState)
  // A custom-engine task with no genuine activity signal has nothing to
  // animate — the monitor can't read its transcript (monitor/activity.ts),
  // so a spinner here would lie. Hook-driven words (rate limited / needs
  // permission / error) are engine-agnostic, so if one DID fire we still
  // honour it; we only fall back to the neutral affordance when there isn't
  // one. `hasActivity` also covers `turn_complete` / `running` from hooks.
  const untrackedCustomEngine = isCustomEngineTask(task) && !hasActivity
  // A daemon job in flight (worktree materialising) outranks everything,
  // including the untracked-custom-engine fallback — the job signal is a
  // genuine daemon-side liveness fact, not engine telemetry, so the spinner
  // never lies here even for a custom engine.
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
  // Subtitle priority: the materializing word while a worktree job runs
  // (there is no branch on disk yet), then a non-normal activity word (rate
  // limited / needs permission / error), then the branch, then — for an
  // untracked custom engine with no branch — an explicit "no activity
  // tracking" note so the row reads as un-tracked rather than stuck, then
  // the lifecycle label (a neutral dash for `backlog`, never the word).
  const fallbackSubtitle = untrackedCustomEngine ? noTrackingSubtitle() : statusLabel(task.status)
  const subtitleText = materializing
    ? opts.truncateBranch(materializingSubtitle(), opts.subtitleBudget)
    : activityLabel
      ? opts.truncateBranch(activityLabel.text, opts.subtitleBudget)
      : branch.length > 0
        ? opts.truncateBranch(branch, opts.subtitleBudget)
        : opts.truncateBranch(fallbackSubtitle, opts.subtitleBudget)
  // Untracked custom engine: a static dim dot instead of the spinner / empty
  // backlog badge, so liveness reads as "not tracked" rather than frozen.
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

/**
 * Overlay the LIVE spinner frame onto a row view built with a fixed
 * `spinnerFrame: 0`. The frame is passed as an ACCESSOR and read only
 * when the row is actually loading — inside a Solid memo that makes the
 * 10Hz frame signal a conditional dependency, so an idle row never
 * re-derives on the spinner tick (waste audit: with N tasks and nothing
 * running, every row used to rebuild its whole view 10×/s; now the tick
 * has zero subscribers when no row spins). For a loading row this
 * reproduces exactly what `buildSidebarRowView` would have produced with
 * the live frame: both glyph fields carry the spinner.
 */
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
