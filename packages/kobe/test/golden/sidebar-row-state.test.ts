/**
 * GOLDEN — the sidebar's row-state vocabulary, locked.
 *
 * `sidebar-row-state.golden.txt` is the ground truth for what a sidebar row
 * shows in every state it can be in: the status glyph, its tone, whether the
 * row animates, and what the subtitle reads. The enumeration lives in
 * `sidebar-state-matrix.ts`; this file only pins its output.
 *
 * The point of a golden here rather than more prose assertions: the row view
 * is a PRIORITY LADDER (deletion > materializing job > activity word > branch)
 * whose rungs are individually reasonable and collectively easy to reorder by
 * accident. A hand-written case proves the rung its author was thinking about.
 * A committed table proves all of them at once — and turns any change into a
 * reviewable diff instead of a silent behavior shift.
 *
 * Locale is pinned to English on purpose: several subtitles come from `t()`,
 * so a golden captured under a different active language would be a different
 * document. The locale cell is process-wide, so this restores it afterwards.
 *
 * After an INTENTIONAL change:
 *     KOBE_UPDATE_GOLDEN=1 bun run test:fast
 * then read the diff — every moved line should be one you meant to move.
 */

import { engineEntry } from "@/engine/registry"
import { DEFAULT_SPINNER_FRAMES } from "@/engine/spinner-frames"
import { currentLang, setLocaleLang } from "@/tui/i18n"
import { buildSidebarRowView } from "@/tui/panes/sidebar/row-view"
import { truncateBranchLabel } from "@/tui/panes/sidebar/view-core"
import { type Task, toTaskId } from "@/types/task"
import { BUILTIN_VENDORS } from "@/types/vendor"
import { afterAll, beforeAll, expect, test } from "vitest"
import { goldenDocument, goldenPath, matchGolden } from "./golden-file"
import {
  OMITTED_FIELDS,
  RECORDED_FIELDS,
  activityCrossProduct,
  completionGraceBlock,
  mainRowBlock,
  prChipBlock,
  spinnerBlock,
  statusVsActivityBlock,
  subagentBlock,
  subtitleBudgetBlock,
  tabActivityBlock,
} from "./sidebar-state-matrix"

const GOLDEN = goldenPath(import.meta.url, "sidebar-row-state.golden.txt")

/** Built once and shared: the golden document and the structural floor below
 *  assert over the SAME enumeration, and it is a pure function either way. */
const CROSS_PRODUCT = activityCrossProduct()

let restoreLang = "en"
beforeAll(() => {
  restoreLang = currentLang()
  setLocaleLang("en")
})
afterAll(() => {
  setLocaleLang(restoreLang as Parameters<typeof setLocaleLang>[0])
})

test("sidebar row state matrix matches the committed golden", () => {
  const document = goldenDocument("sidebar row state — buildSidebarRowView over its full input space", [
    {
      title: "activity x completionSeen x job x deletion x vendor x transcript (full cross product)",
      lines: CROSS_PRODUCT,
    },
    { title: "project (main) rows — branch resolved from the repo checkout", lines: mainRowBlock() },
    { title: "engine-owned spinner frame sets + withSpinnerFrame overlay", lines: spinnerBlock() },
    { title: "turn-complete vs transcript growth — the still-working grace window", lines: completionGraceBlock() },
    { title: "subagent marks ride the animation only", lines: subagentBlock() },
    { title: "subtitle truncation budget", lines: subtitleBudgetBlock() },
    {
      title: "persisted TaskStatus x runtime activity — status must not reach the row",
      lines: statusVsActivityBlock(),
    },
    { title: "PR check chip", lines: prChipBlock() },
    { title: "tabRowActivity — which entry a TAB row may read", lines: tabActivityBlock() },
  ])

  expect(matchGolden(GOLDEN, document)).toBeNull()
})

/**
 * Two invariants the table cannot state about itself, checked against the same
 * enumeration so they can never disagree with what the golden captured.
 */
test("no spinner frame collides with a settled-state badge glyph", () => {
  // A running row that borrows `●`/`○`/`◌` reads as a finished one — this is
  // why the reduced-motion pulse was removed, and the collision would
  // otherwise be invisible in a golden full of correct-looking glyphs.
  //
  // Iterates the engine registry's FRAME ARRAYS, not the golden's rendered
  // `frames(0..25)` column. Parsing that column silently bounded the guard at
  // 26 frames, so a set longer than that went unchecked past index 25 — and
  // the whole point is that a single bad frame anywhere in a set is enough.
  //
  // `·` is deliberately NOT in this set. Claude's brand frames open and close
  // on it (lifted from claude-code's own spinner), and the two other places
  // `·` appears — the untracked-custom-engine rest glyph and the non-agent tab
  // dot — are states this row cannot simultaneously be in: a builtin-vendor
  // task is not an untracked custom engine, and a spinner only renders on an
  // agent row. The ambiguity this guard exists to prevent is within ONE row's
  // own vocabulary.
  const settled = new Set(["●", "○", "◌", "✓", "?", "◷", "✕"])
  const sets: Array<[string, readonly string[]]> = [
    ...BUILTIN_VENDORS.map((vendor): [string, readonly string[]] => [
      vendor,
      engineEntry(vendor).spinnerFrames ?? DEFAULT_SPINNER_FRAMES,
    ]),
    ["<fallback>", DEFAULT_SPINNER_FRAMES],
  ]
  expect(sets.length).toBeGreaterThan(1)
  for (const [vendor, frames] of sets) {
    expect({ vendor, empty: frames.length === 0 }).toEqual({ vendor, empty: false })
    for (const glyph of frames) {
      expect({ vendor, glyph, collides: settled.has(glyph) }).toEqual({ vendor, glyph, collides: false })
    }
  }
})

test("every row the matrix produces has a non-empty glyph and subtitle", () => {
  // A blank cell renders as a hole in the rail rather than a state, and the
  // golden would happily record the hole. Cheap structural floor under it.
  for (const line of CROSS_PRODUCT) {
    expect(line).toMatch(/ glyph=\S/)
    expect(line).toMatch(/ title=\S/)
    expect(line).toMatch(/ sub=\S/)
  }
})

/**
 * The golden records a chosen SUBSET of `SidebarRowView`'s fields, and the
 * first cut of this suite chose it wrong — `isMain`, `titleText` and
 * `materializing` were all absent, so those could regress without moving a
 * line. This makes the subset a decision the type system enforces: a field
 * added to the interface belongs in RECORDED_FIELDS or in the documented
 * omission list, and until someone says which, this fails.
 */
test("every field of SidebarRowView is either recorded in the golden or explicitly omitted", () => {
  const sample = buildSidebarRowView({
    task: {
      id: toTaskId("01JCTASKTASKTASKTASKTASK"),
      title: "t",
      repo: "/repos/kobe",
      branch: "feat/x",
      worktreePath: "/wt/x",
      kind: "task",
      status: "in_progress",
      archived: false,
      pinned: false,
      vendor: "claude",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as Task,
    spinnerFrame: 0,
    subtitleBudget: 32,
    truncateBranch: truncateBranchLabel,
  })
  expect(Object.keys(sample).sort()).toEqual([...RECORDED_FIELDS, ...OMITTED_FIELDS].sort())
})
