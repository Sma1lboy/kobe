import type { TaskEngineState, TaskJobState } from "@/client/remote-orchestrator"
import type { TaskActivityState } from "@/engine/hook-events"
import { engineEntry } from "@/engine/registry"
import { DEFAULT_SPINNER_FRAMES, REDUCED_MOTION_SPINNER_FRAMES } from "@/engine/spinner-frames"
import { t } from "@/tui/i18n"
import { DEFAULT_TASK_VENDOR, type Task } from "@/types/task"
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
  /**
   * The engine-owned frame set this row animates with while loading
   * (registry `spinnerFrames`, braille fallback). Carried on the view so
   * `withSpinnerFrame` needs no extra caller wiring.
   */
  readonly spinnerFrames: readonly string[]
  /**
   * A daemon job (worktree add) is materialising this task — the subtitle
   * renders the indeterminate sweep bar instead of the shimmer.
   */
  readonly materializing: boolean
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

/** Neutral fallback frames — kept under the historical name for existing consumers/tests. */
export const IN_PROGRESS_SPINNER: readonly string[] = DEFAULT_SPINNER_FRAMES

export const SPINNER_FRAME_MS = 100

/**
 * Cycle length for the shared 10Hz frame counter. Engine frame sets have
 * different lengths (braille 10, claude's star oscillation 12); the counter
 * ticks over a common multiple and each row reduces modulo its own set, so
 * every set loops seamlessly. 600 covers every divisor we'd plausibly ship
 * (8/10/12/15/20/24/25).
 */
export const SPINNER_TICK_CYCLE = 600

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

/** The inputs that decide whether a row spins — the loading subset of
 *  `buildSidebarRowView`'s options. */
export interface RowLoadingInputs {
  readonly task: Task
  readonly activity?: TaskEngineState
  readonly job?: TaskJobState
}

/**
 * Whether a single row is in its loading (spinning) state. THE source of the
 * `loading` decision — `buildSidebarRowView` calls this, so a pane-level
 * "does anything spin" check built on it can never drift from what the rows
 * actually render (a drift would freeze a genuinely-loading row's spinner,
 * which is worse than the idle CPU tax it saves). Pure.
 */
export function rowIsLoading(opts: RowLoadingInputs): boolean {
  const { task } = opts
  const activityState = opts.activity?.state
  const hasActivity = activityState !== undefined
  const untrackedCustomEngine = isCustomEngineTask(task) && !hasActivity
  const materializing = opts.job !== undefined
  return materializing || (!untrackedCustomEngine && activityState === "running")
}

/**
 * Pane-level "is ANY visible row spinning" — the gate the React Sidebar uses
 * to suspend its 10Hz spinner interval while everything is idle (O11). Built
 * on the exact same `rowIsLoading` per-row decision the cards render with, so
 * the timer is present precisely when a row needs animating.
 */
export function anyRowLoading(
  tasks: readonly Task[],
  reads: {
    activity(taskId: string): TaskEngineState | undefined
    job(taskId: string): TaskJobState | undefined
  },
): boolean {
  return tasks.some((task) =>
    rowIsLoading({
      task,
      activity: reads.activity(task.id),
      job: reads.job(task.id),
    }),
  )
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
  /** Accessibility: swap the engine spinner for the slow pulsing dot. */
  readonly reducedMotion?: boolean
}): SidebarRowView {
  const { task } = opts
  const isMain = task.kind === "main"
  // Regular tasks store their branch; a `main` row's branch lives in the repo
  // root checkout, resolved by the caller and passed as `mainBranch`.
  const branch = isMain ? (opts.mainBranch ?? "") : task.branch
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
  const loading = rowIsLoading({
    task,
    activity: opts.activity,
    job: opts.job,
  })
  // Engine-owned brand frames (registry `spinnerFrames`), braille fallback;
  // reduced motion replaces every set with the slow pulsing dot.
  const spinnerFrames = opts.reducedMotion
    ? REDUCED_MOTION_SPINNER_FRAMES
    : (engineEntry(task.vendor ?? DEFAULT_TASK_VENDOR).spinnerFrames ?? DEFAULT_SPINNER_FRAMES)
  const spinner = spinnerFrames[opts.spinnerFrame % spinnerFrames.length] ?? spinnerFrames[0]
  const tone = materializing
    ? "primary"
    : untrackedCustomEngine
      ? "textMuted"
      : (activityLabel?.tone ?? (loading ? "primary" : (activityBadge?.tone ?? "textMuted")))
  // Subtitle priority: the materializing word while a worktree job runs
  // (there is no branch on disk yet), then a non-normal activity word (rate
  // limited / needs permission / error), then the branch, then — for an
  // untracked custom engine with no branch — an explicit "no activity
  // tracking" note so the row reads as un-tracked rather than stuck, then a
  // neutral dash. Persisted task lifecycle belongs to the board, not this
  // runtime-activity projection.
  const fallbackSubtitle = untrackedCustomEngine ? noTrackingSubtitle() : "—"
  const subtitleText = materializing
    ? opts.truncateBranch(materializingSubtitle(), opts.subtitleBudget)
    : activityLabel
      ? opts.truncateBranch(activityLabel.text, opts.subtitleBudget)
      : branch.length > 0
        ? opts.truncateBranch(branch, opts.subtitleBudget)
        : opts.truncateBranch(fallbackSubtitle, opts.subtitleBudget)
  // Untracked custom engine gets a distinct dim dot. Normal tasks fall back
  // to the hollow idle circle because the client deliberately removes an
  // explicit `idle` activity entry; absence is therefore the idle projection.
  const restGlyph = untrackedCustomEngine ? NO_TRACKING_GLYPH : (activityBadge?.glyph ?? "○")
  const restProjectGlyph = untrackedCustomEngine ? NO_TRACKING_GLYPH : (activityBadge?.glyph ?? "★")
  return {
    isMain,
    titleText: isMain ? repoBasename(task.repo) : task.title,
    subtitleText,
    loading,
    stateGlyph: loading ? spinner : restGlyph,
    projectGlyph: loading ? spinner : restProjectGlyph,
    tone,
    spinnerFrames,
    materializing,
  }
}

/**
 * Overlay the LIVE spinner frame onto a row view built with a fixed
 * `spinnerFrame: 0`. The frame is passed as an ACCESSOR and read only
 * when the row is actually loading — inside a Solid memo that makes the
 * 10Hz frame signal a conditional dependency, so an idle row never
 * re-derives on the spinner tick (with N tasks and nothing running, the
 * tick has zero subscribers — no row rebuilds its view 10×/s). For a loading row this
 * reproduces exactly what `buildSidebarRowView` would have produced with
 * the live frame: both glyph fields carry the spinner.
 */
export function withSpinnerFrame(view: SidebarRowView, frame: () => number): SidebarRowView {
  if (!view.loading) return view
  const frames = view.spinnerFrames
  const spinner = frames[frame() % frames.length] ?? frames[0] ?? "⠋"
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
