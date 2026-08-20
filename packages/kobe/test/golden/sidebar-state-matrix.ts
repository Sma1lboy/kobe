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
import type { SidebarRowView } from "@/tui/panes/sidebar/row-view"
import { buildSidebarRowView, prCheckChip, rowIsLoading, withSpinnerFrame } from "@/tui/panes/sidebar/row-view"
import { tabRowActivity } from "@/tui/panes/sidebar/tree-core"
import { truncateBranchLabel } from "@/tui/panes/sidebar/view-core"
import { type Task, type TaskDeletionPhase, type TaskStatus, toTaskId } from "@/types/task"
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

/** `undefined` is a real, distinct INPUT everywhere below — no activity entry
 *  at all reaches different code than an `idle` one, even though both now
 *  render as the same dim `·` (the tab row's separate `◌ unknown` glyph was
 *  dropped 2026-08-15). Keeping them apart here is what proves that. */
const ACTIVITY_STATES: ReadonlyArray<TaskActivityState | undefined> = [undefined, ...TASK_ACTIVITY_STATES]

const DELETION_PHASES = [undefined, "queued", "running", "error"] as const

// `TaskDeletionPhase` is a bare type union with no runtime array to spread, so
// the list above is hand-maintained. This makes that safe: adding a member
// upstream without extending DELETION_PHASES stops compiling here.
type _DeletionPhasesExhaustive = Exclude<TaskDeletionPhase, (typeof DELETION_PHASES)[number]> extends never
  ? true
  : ["DELETION_PHASES is missing a TaskDeletionPhase member"]
const _deletionPhasesExhaustive: _DeletionPhasesExhaustive = true
void _deletionPhasesExhaustive

/**
 * Every vendor, not a sample. `BUILTIN_VENDORS` is spread rather than listed:
 * each engine owns its own `spinnerFrames`, so a vendor added upstream changes
 * what these rows render — and a hand-written list would silently keep the new
 * one out of the "full cross product" this file claims to emit.
 */
const VENDORS: readonly string[] = [...BUILTIN_VENDORS, CUSTOM_VENDOR]

function task(over: Partial<Task> = {}): Task {
  return {
    id: toTaskId("01JCTASKTASKTASKTASKTASK"),
    title: "fix the sidebar",
    repo: "/repos/rove",
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

/**
 * Every scalar field of `SidebarRowView`, in the order the golden prints them.
 *
 * Hand-picking a subset is how a golden quietly reintroduces the sampling
 * problem it exists to remove: the first cut of this file recorded only
 * glyph/tone/loading/subtitle, so `isMain`, `titleText` and `materializing`
 * (which selects the sweep bar over the shimmer) could all have regressed
 * without moving a single line. {@link RECORDED_FIELDS} is therefore checked
 * against the real object's keys by the test — adding a field to the interface
 * fails loudly until someone decides where it belongs.
 *
 * `spinnerFrames` is the one deliberate omission: it is constant per vendor and
 * printed in full by {@link spinnerBlock}, so repeating it on all 1120 rows
 * would be noise, not coverage.
 */
export const RECORDED_FIELDS = [
  "isMain",
  "titleText",
  "stateGlyph",
  "tone",
  "loading",
  "materializing",
  "subtitleText",
] as const

export const OMITTED_FIELDS = ["spinnerFrames"] as const

/** One row of the golden, in fixed columns so a diff points at the field that
 *  moved rather than reflowing the whole line. */
function row(inputs: readonly string[], view: SidebarRowView): string {
  const cells = [
    `main=${view.isMain ? 1 : 0}`,
    pad(`title=${view.titleText}`, 22),
    pad(`glyph=${view.stateGlyph}`, 9),
    pad(`tone=${view.tone}`, 16),
    `load=${view.loading ? 1 : 0}`,
    `matz=${view.materializing ? 1 : 0}`,
    `sub=${view.subtitleText}`,
  ]
  return `${inputs.join(" ")} | ${cells.join(" ")}`
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
          for (const vendor of VENDORS) {
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
  for (const vendor of VENDORS) {
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
  //
  // `sameAsDirect` is the part a glyph column alone would miss: the overlay
  // must reproduce EXACTLY what `buildSidebarRowView` would have returned with
  // that frame — every field, not just the one it rewrites. A divergence in
  // tone or subtitle between the two paths means an animating row and a
  // freshly-built one disagree about the same state.
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
      const direct = build({ task: task(), activity: activityOf(state), spinnerFrame: frame })
      const sameAsDirect = RECORDED_FIELDS.every((field) => overlaid[field] === direct[field])
      lines.push(
        `${pad(`act=${state ?? "-"}`, 22)} ${pad(`frame=${frame}`, 10)} overlay: base=${base.stateGlyph} after=${
          overlaid.stateGlyph
        } ${pad(`tone=${overlaid.tone}`, 16)} ${pad(`sub=${overlaid.subtitleText}`, 20)} frameReads=${reads} sameObject=${
          overlaid === base ? 1 : 0
        } sameAsDirect=${sameAsDirect ? 1 : 0}`,
      )
    }
  }
  lines.push(`defaultFrames=${DEFAULT_SPINNER_FRAMES.join("")}`)
  return lines
}

/**
 * Persisted board lifecycle (`TaskStatus`) crossed with runtime activity.
 *
 * The row is a RUNTIME projection: `status` is user-driven and must never
 * reach it, so every column here should be identical down the `status` axis
 * and vary only with `act`. Written as a golden block rather than left to the
 * collapse assertion in `sidebar-row-view.test.ts` because that one only
 * proves the collapse with activity ABSENT — the case this block adds back is
 * "a `done` task whose engine is asking for permission still shows `?`".
 */
export function statusVsActivityBlock(): string[] {
  const statuses: readonly TaskStatus[] = ["backlog", "in_progress", "in_review", "done", "canceled", "error"]
  const lines: string[] = []
  for (const status of statuses) {
    for (const state of ACTIVITY_STATES) {
      const view = build({ task: task({ status }), activity: activityOf(state) })
      lines.push(row([pad(`status=${status}`, 20), pad(`act=${state ?? "-"}`, 22)], view))
    }
  }
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
  // With no rollup either there is nothing to fall back to — the tab row
  // rests at the shared no-state dot.
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
