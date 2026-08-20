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

import { DEFAULT_SPINNER_FRAMES } from "@/engine/spinner-frames"
import { currentLang, setLocaleLang } from "@/tui/i18n"
import { NO_STATE_GLYPH, buildSidebarRowView } from "@/tui/panes/sidebar/row-view"
import { truncateBranchLabel } from "@/tui/panes/sidebar/view-core"
import { type Task, toTaskId } from "@/types/task"
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
      lines: activityCrossProduct(),
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
  // A running row that borrows `●`/`○`/`·` reads as a finished one — this is
  // why the reduced-motion pulse was removed, and the collision would
  // otherwise be invisible in a golden full of correct-looking glyphs.
  //
  // `·` joined this set on 2026-08-15, when it became the single no-state
  // glyph (untracked custom engine + non-agent tab + unobserved agent tab) and
  // simultaneously stopped being a spinner frame — Claude's brand set, which
  // opened and closed on it, was removed the same day.
  const settled = new Set(["●", "○", "·", "✓", "?", "◷", "×"])
  const spinnerLines = spinnerBlock().filter((line) => line.includes("frames(0..25)="))
  expect(spinnerLines.length).toBeGreaterThan(0)
  for (const line of spinnerLines) {
    const frames = line.split("frames(0..25)=")[1] ?? ""
    for (const glyph of frames) {
      expect({ line, glyph, collides: settled.has(glyph) }).toEqual({ line, glyph, collides: false })
    }
  }
})

/**
 * Every glyph the rail can render must survive the FONT, not just the layout.
 *
 * kobe reserves one cell per state glyph, and both the width table and opentui
 * agree on one cell for all of these. The terminal may not: when the user's
 * font lacks a codepoint, the OS substitutes another face at ITS advance, and
 * a CJK or dingbat substitute is 1.1–1.6 cells wide — it overruns into the
 * label beside it. Ambiguous-width codepoints hide this, because everyone in
 * the pipeline still calls them 1 cell.
 *
 * That shipped: `◌` U+25CC (the tab row's old "unknown" glyph) is absent from
 * FiraCode Nerd Font and SF Mono, so macOS drew it from HiraginoSans at 1.62
 * cells and it sat on the first letter of every tab name (2026-08-15). `✕`
 * U+2715 did the same at 1.24 cells via ZapfDingbats.
 *
 * So the vocabulary is an allowlist, and adding to it means checking the
 * candidate against the fonts people actually run first. The dingbat block
 * (U+2700–U+27BF) and the geometric shapes a Latin mono font typically skips
 * are what to avoid; Latin-1, ASCII, and the four filled/hollow circles are
 * present essentially everywhere.
 */
test("every rendered glyph is in the font-verified vocabulary", () => {
  const VERIFIED = new Map<string, string>([
    ["·", "U+00B7 Latin-1 — the no-state dot"],
    ["×", "U+00D7 Latin-1 — error / failed deletion"],
    ["○", "U+25CB — idle; in every mono font checked"],
    ["●", "U+25CF — unread completion; ditto"],
    ["◇", "U+25C7 — subagent count prefix"],
    ["◷", "U+25F7 — rate limited (falls back to Menlo at 1 cell where absent)"],
    ["✓", "U+2713 — seen; the one dingbat-adjacent glyph both fonts carry"],
    ["?", "ASCII — needs input"],
    ["▴", "U+25B4 — pinned marker"],
    ...DEFAULT_SPINNER_FRAMES.map((frame) => [frame, "braille — uniform AppleBraille fallback"] as const),
  ])
  // Glyph cells the matrix emits, plus the constants the tab rows render
  // directly (they never reach `buildSidebarRowView`).
  const rendered = new Set<string>([NO_STATE_GLYPH])
  for (const line of activityCrossProduct()) {
    const glyph = / glyph=(\S+)/.exec(line)?.[1]
    if (glyph) for (const ch of glyph) rendered.add(ch)
  }
  for (const glyph of rendered) {
    expect({ glyph, verified: VERIFIED.has(glyph) }).toEqual({ glyph, verified: true })
  }
})

test("every row the matrix produces has a non-empty glyph and subtitle", () => {
  // A blank cell renders as a hole in the rail rather than a state, and the
  // golden would happily record the hole. Cheap structural floor under it.
  for (const line of activityCrossProduct()) {
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
      repo: "/repos/rove",
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
