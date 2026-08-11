/**
 * The sidebar's state vocabulary, enumerated.
 *
 * `buildSidebarRowView` is the single place that decides what a sidebar row
 * SAYS: which status glyph it wears, which tone colours it, whether it
 * animates, and what its subtitle reads. Every one of those answers falls out
 * of a priority ladder — deletion outranks a materializing job, which outranks
 * a hook-driven activity word, which outranks the branch — and the ladder is
 * exactly the kind of thing that drifts one rung at a time under unrelated
 * fixes. Prose assertions catch the rung someone thought to write down.
 *
 * So this module renders the ladder's WHOLE input space to text instead. It
 * owns no assertions: it produces the canonical rows, and
 * `sidebar-row-state.test.ts` locks them against the committed golden.
 *
 * Keeping it separate from the test file is what lets the enumeration stay
 * exhaustive without the test file outgrowing the size cap, and it means the
 * matrix can be printed by hand (`bun test/golden/sidebar-state-matrix.ts`)
 * while investigating a diff.
 */

import type { TaskEngineState, TaskJobState } from "@/client/remote-orchestrator"
import type { TaskActivityState } from "@/engine/hook-events"
import { TASK_ACTIVITY_STATES } from "@/engine/hook-events"
import { DEFAULT_SPINNER_FRAMES } from "@/engine/spinner-frames"
import { buildSidebarRowView, prCheckChip, rowIsLoading, withSpinnerFrame } from "@/tui/panes/sidebar/row-view"
import { tabRowActivity } from "@/tui/panes/sidebar/tree-core"
import { truncateBranchLabel } from "@/tui/panes/sidebar/view-core"
import { type Task, toTaskId } from "@/types/task"
import { BUILTIN_VENDORS } from "@/types/vendor"
import { pad } from "./golden-file"

/** Fixed instant every `at` / `mtimeMs` in the matrix is expressed against —
 *  the row view compares timestamps, so a wall-clock read would make the
 *  golden depend on when it ran. */
export const NOW = 1_760_000_000_000

/** Wide enough that nothing in the matrix truncates by accident, so a
 *  truncation in the golden is a real one. The dedicated budget block below
 *  exercises the narrow end on purpose. */
const SUBTITLE_BUDGET = 32

const BRANCH = "feat/sidebar"

/** A non-builtin engine id — the "no transcript store to watch" branch. */
const CUSTOM_VENDOR = "my-engine"

/** `undefined` is a real, distinct input everywhere below: no activity entry
 *  at all is not the same as an `idle` one, and the difference is what the
 *  tab row's `◌ unknown` glyph exists to say. */
const ACTIVITY_STATES: ReadonlyArray<TaskActivityState | undefined> = [undefined, ...TASK_ACTIVITY_STATES]

const DELETION_PHASES = [undefined, "queued", "running", "error"] as const

function task(over: Partial<Task> = {}): Task {
  return {
    id: toTaskId("01JCTASKTASKTASKTASKTASK"),
    title: "fix the sidebar",
    repo: "/repos/kobe",
    branch: BRANCH,
    worktreePath: "/wt/sidebar",
    kind: "task",
    status: "in_progress",
    archived: false,
    pinned: false,
    vendor: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Task
}

function activityOf(state: TaskActivityState | undefined, at = NOW): TaskEngineState | undefined {
  return state === undefined ? undefined : { state, at }
}

const JOB: TaskJobState = { kind: "ensureWorktree" }

/** One row of the golden, in fixed columns so a diff points at the field that
 *  moved rather than reflowing the whole line. */
function row(
  inputs: readonly string[],
  view: { stateGlyph: string; tone: string; loading: boolean; subtitleText: string },
): string {
  return `${inputs.join(" ")} | ${pad(`glyph=${view.stateGlyph}`, 9)} ${pad(`tone=${view.tone}`, 16)} load=${
    view.loading ? 1 : 0
  } sub=${view.subtitleText}`
}

function build(opts: {
  task: Task
  activity?: TaskEngineState
  job?: TaskJobState
  transcript?: { mtimeMs: number }
  lifecycle?: { subagents: number }
  spinnerFrame?: number
  completionSeen?: boolean
  mainBranch?: string
  subtitleBudget?: number
}) {
  return buildSidebarRowView({
    task: opts.task,
    activity: opts.activity,
    job: opts.job,
    transcript: opts.transcript,
    lifecycle: opts.lifecycle,
    spinnerFrame: opts.spinnerFrame ?? 0,
    subtitleBudget: opts.subtitleBudget ?? SUBTITLE_BUDGET,
    truncateBranch: truncateBranchLabel,
    completionSeen: opts.completionSeen,
    mainBranch: opts.mainBranch,
  })
}

/**
 * The full cross product of the six inputs that feed the priority ladder.
 *
 * Not a sampled selection: every combination is emitted, so a change that
 * reorders two rungs shows up as a block of moved lines instead of hiding in
 * whichever combination nobody wrote a case for.
 */
export function activityCrossProduct(): string[] {
  const lines: string[] = []
  for (const state of ACTIVITY_STATES) {
    for (const seen of [false, true]) {
      for (const job of [false, true]) {
        for (const deletion of DELETION_PHASES) {
          for (const vendor of ["claude", "codex", CUSTOM_VENDOR]) {
            for (const tx of [false, true]) {
              const subject = task({
                vendor: vendor as Task["vendor"],
                deletion:
                  deletion === undefined
                    ? undefined
                    : { phase: deletion, force: false, requestedAt: "2026-01-01T00:00:00.000Z" },
              })
              // A transcript written well past the completion hook is the
              // "still working" signal; the same fact is inert for every
              // other activity state, which is itself worth locking.
              const view = build({
                task: subject,
                activity: activityOf(state),
                job: job ? JOB : undefined,
                transcript: tx ? { mtimeMs: NOW + 10_000 } : undefined,
                completionSeen: seen,
              })
              lines.push(
                row(
                  [
                    pad(`act=${state ?? "-"}`, 22),
                    `seen=${seen ? 1 : 0}`,
                    `job=${job ? 1 : 0}`,
                    pad(`del=${deletion ?? "-"}`, 12),
                    pad(`vendor=${vendor}`, 17),
                    `tx=${tx ? "after" : "-"}`,
                  ],
                  view,
                ),
              )
            }
          }
        }
      }
    }
  }
  return lines
}

/** A project (`main`) row resolves its branch from the repo checkout, not from
 *  `task.branch` — and falls back to a neutral dash when the caller has none. */
export function mainRowBlock(): string[] {
  const lines: string[] = []
  for (const mainBranch of ["main", "feat/long-running-branch", ""]) {
    for (const state of ACTIVITY_STATES) {
      const view = build({
        task: task({ kind: "main", branch: "", title: "kobe" }),
        activity: activityOf(state),
        mainBranch,
      })
      lines.push(row([pad(`mainBranch=${mainBranch || "-"}`, 34), pad(`act=${state ?? "-"}`, 22)], view))
    }
  }
  return lines
}

/**
 * The animating glyph is engine-owned (`registry.spinnerFrames`), so the frame
 * set is part of the contract — and every frame in every set must stay visually
 * distinct from the settled badges, or a RUNNING row reads as a finished one.
 */
export function spinnerBlock(): string[] {
  const lines: string[] = []
  for (const vendor of [...BUILTIN_VENDORS, CUSTOM_VENDOR]) {
    const frames: string[] = []
    // Two full cycles plus an out-of-range index: the modulo wrap is the part
    // that silently breaks when a frame set changes length.
    for (let frame = 0; frame < 26; frame++) {
      const view = build({
        task: task({ vendor: vendor as Task["vendor"] }),
        activity: activityOf("running"),
        spinnerFrame: frame,
      })
      frames.push(view.stateGlyph)
    }
    lines.push(`${pad(`vendor=${vendor}`, 17)} frames(0..25)=${frames.join("")}`)
  }
  // `withSpinnerFrame` overlays the live frame onto a view built at frame 0.
  // Its identity contract (an idle view is returned UNCHANGED, and the frame
  // accessor is never even read) is what keeps an idle row off the 10Hz tick.
  for (const state of ACTIVITY_STATES) {
    // Frame 0 reproduces the view it was built with (identity must survive);
    // 3 is an ordinary live frame; a frame past the set's length must wrap
    // rather than blank the glyph.
    for (const frame of [0, 3, 14, 99]) {
      const base = build({ task: task(), activity: activityOf(state) })
      let reads = 0
      const overlaid = withSpinnerFrame(base, () => {
        reads++
        return frame
      })
      lines.push(
        `${pad(`act=${state ?? "-"}`, 22)} ${pad(`frame=${frame}`, 10)} overlay: base=${base.stateGlyph} after=${
          overlaid.stateGlyph
        } frameReads=${reads} sameObject=${overlaid === base ? 1 : 0}`,
      )
    }
  }
  lines.push(`defaultFrames=${DEFAULT_SPINNER_FRAMES.join("")}`)
  return lines
}

/**
 * The completion/transcript race: a `turn-complete` hook whose transcript kept
 * growing afterwards is not a completion. The grace window absorbs the
 * sub-second race between the last write and the hook, so the boundary itself
 * is behavior worth pinning.
 */
export function completionGraceBlock(): string[] {
  const lines: string[] = []
  for (const offset of [-5_000, -1, 0, 1, 1_999, 2_000, 2_001, 60_000]) {
    for (const seen of [false, true]) {
      const view = build({
        task: task(),
        activity: activityOf("turn_complete"),
        transcript: { mtimeMs: NOW + offset },
        completionSeen: seen,
      })
      lines.push(row([pad(`mtime=at${offset >= 0 ? "+" : ""}${offset}ms`, 22), `seen=${seen ? 1 : 0}`], view))
    }
  }
  // No transcript facts at all, and a ZERO mtime (a record the collector wrote
  // before it could stat the file) — both are the pre-daemon-collector path,
  // which must stay exactly the old behavior rather than guessing.
  for (const seen of [false, true]) {
    const view = build({ task: task(), activity: activityOf("turn_complete"), completionSeen: seen })
    lines.push(row([pad("mtime=<none>", 22), `seen=${seen ? 1 : 0}`], view))
  }
  for (const seen of [false, true]) {
    const view = build({
      task: task(),
      activity: activityOf("turn_complete"),
      transcript: { mtimeMs: 0 },
      completionSeen: seen,
    })
    lines.push(row([pad("mtime=0", 22), `seen=${seen ? 1 : 0}`], view))
  }
  // The same fact read through `rowIsLoading`, the predicate the pane-level
  // spinner gate is built on: it must agree with the view's own `loading` for
  // every one of these, or a genuinely-working row freezes mid-animation.
  for (const offset of [-5_000, 1_999, 2_001, 60_000]) {
    const inputs = {
      task: task(),
      activity: activityOf("turn_complete"),
      transcript: { mtimeMs: NOW + offset },
    }
    const view = build(inputs)
    lines.push(
      `${pad(`mtime=at${offset >= 0 ? "+" : ""}${offset}ms`, 22)} rowIsLoading=${rowIsLoading(inputs) ? 1 : 0} viewLoading=${
        view.loading ? 1 : 0
      }`,
    )
  }
  return lines
}

/** Subagent marks ride as a `◇N` prefix — and ONLY while the row animates, so
 *  a mark whose end event never arrived can never caption a quiet row. */
export function subagentBlock(): string[] {
  const lines: string[] = []
  for (const subagents of [0, 1, 3, 12]) {
    for (const state of ACTIVITY_STATES) {
      for (const branch of [BRANCH, ""]) {
        const view = build({
          task: task({ branch }),
          activity: activityOf(state),
          lifecycle: { subagents },
        })
        lines.push(
          row(
            [pad(`subagents=${subagents}`, 14), pad(`act=${state ?? "-"}`, 22), pad(`branch=${branch || "-"}`, 20)],
            view,
          ),
        )
      }
    }
  }
  return lines
}

/** Subtitle truncation is the row's only defence against a long branch pushing
 *  the right-edge cluster off the rail. */
export function subtitleBudgetBlock(): string[] {
  const lines: string[] = []
  const branch = "feature/a-very-long-branch-name-indeed"
  for (const budget of [0, 1, 4, 8, 16, 24, 40]) {
    for (const state of [undefined, "running", "rate_limited", "error"] as const) {
      const view = build({ task: task({ branch }), activity: activityOf(state), subtitleBudget: budget })
      lines.push(row([pad(`budget=${budget}`, 11), pad(`act=${state ?? "-"}`, 22)], view))
    }
  }
  return lines
}

/** The PR-check chip is a pure map from the daemon-written `checkState`. */
export function prChipBlock(): string[] {
  const states = [undefined, "none", "unknown", "passing", "failing", "pending"] as const
  return states.map((checkState) => {
    const subject = task({
      prStatus: checkState === undefined ? undefined : ({ checkState } as Task["prStatus"]),
    })
    const chip = prCheckChip(subject)
    return `${pad(`checkState=${checkState ?? "<no prStatus>"}`, 28)} chip=${chip ? `${chip.glyph} (${chip.tone})` : "<none>"}`
  })
}

/**
 * Which activity entry a TAB row is allowed to read.
 *
 * The task-level entry is a last-event-wins rollup across every tab, so
 * lending it to whichever tab happens to be active lit the tab you switched TO
 * with its sibling's spinner. The rollup may stand in only for a task no tab
 * of which has ever reported.
 */
export function tabActivityBlock(): string[] {
  const lines: string[] = []
  for (const tabActivity of [undefined, "TAB"]) {
    for (const reportedTabCount of [0, 1, 2]) {
      for (const active of [false, true]) {
        const picked = tabRowActivity({
          tabActivity,
          reportedTabCount,
          taskActivity: "ROLLUP",
          active,
        })
        lines.push(
          `${pad(`tabActivity=${tabActivity ?? "-"}`, 20)} ${pad(`reported=${reportedTabCount}`, 12)} ${pad(
            `active=${active ? 1 : 0}`,
            10,
          )} -> ${picked ?? "<none>"}`,
        )
      }
    }
  }
  // With no rollup either there is nothing to fall back to, which is the
  // `◌ unknown` case the tab row renders.
  for (const active of [false, true]) {
    const picked = tabRowActivity({ tabActivity: undefined, reportedTabCount: 0, taskActivity: undefined, active })
    lines.push(
      `${pad("tabActivity=-", 20)} ${pad("reported=0", 12)} ${pad(`active=${active ? 1 : 0}`, 10)} taskActivity=- -> ${
        picked ?? "<none>"
      }`,
    )
  }
  return lines
}
