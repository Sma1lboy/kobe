/**
 * `bun e2e/hero-routines.ts [--out=dir] [--speed=N]` — record the ROUTINES
 * feature demo through the sanctioned `/harness` path (`hero-serve.ts` must
 * be running against the fixture's seeded routines), then encode it to
 * `routines.mp4` + `routines.gif`.
 *
 * What it films is the page's own claim: scheduled prompts the daemon owns,
 * each with the repo it runs in, when it fires next, and the prompt/precheck
 * /run history behind it — then a routine being composed, with the cron cells
 * restating the next fire time in the operator's own clock as they change.
 * That preview is the reason the composer is a card of five labelled cells
 * and not a raw cron string, so it is the beat the take is built around.
 *
 * Costs NO engine quota and involves no live turn: a routine is a daemon
 * record, and the fixture already seeds three. The take deliberately stops
 * short of `run now` / `s` — a firing creates a task and boots an engine in a
 * worktree Claude Code has never seen, which raises the first-run folder-trust
 * prompt (see `hero-seed.ts`) and would film a modal instead of the product.
 *
 * Idempotent, unlike `hero-kanban.ts`: the routine composed on camera is
 * deleted through `rove api routine-delete` after the take, so a re-shoot
 * starts from the same three rows the stills were framed on.
 */

import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { Page } from "@playwright/test"
import { REPO_ROOT, click, encode, look, press, record, type as typeText } from "./hero-capture.ts"
import { heroApi } from "./hero-fixture.ts"

const args = process.argv.slice(2)
const outDir = resolve(args.find((arg) => arg.startsWith("--out="))?.slice(6) ?? join(REPO_ROOT, "docs", "assets"))
const workDir = join(REPO_ROOT, ".scratch", "hero-routines")
/** Real seconds per delivered second. Matches the kanban cut: this one is
 *  read (schedules, a prompt, a preview recomputing), not skimmed. */
const SPEED = Number(args.find((arg) => arg.startsWith("--speed="))?.slice(8) ?? 3)

/**
 * The routine composed on camera, then removed after the take. The name has
 * to agree with the schedule the cron beat lands on (`weekdays at 12:00`) —
 * a demo that files "Nightly …" against a midday schedule reads as a bug.
 */
const NEW_ROUTINE = {
  name: "Midday changelog sweep",
  prompt: "Summarize what merged today and update the changelog draft.",
} as const

/** Sidebar row centres at 1280×800 — the pages sit above the project tree. */
const ROW = { routines: 104 } as const

/** Leave the fixture as we found it, so the next shoot frames the same rows. */
function removeComposedRoutine(): void {
  type Automation = { id: string; name: string }
  const listed = (heroApi(["routine-list"]) as { automations?: Automation[] }).automations ?? []
  const composed = listed.find((automation) => automation.name === NEW_ROUTINE.name)
  if (!composed) {
    console.error(`[hero:routines] the compose beat created nothing — nothing to clean up`)
    return
  }
  heroApi(["routine-delete", "--id", composed.id])
  console.log(`[hero:routines] removed ${composed.id} — fixture restored to 3 routines`)
}

async function storyboard(page: Page): Promise<void> {
  // Beat 1 — the page, opened the discoverable way: the sidebar's own
  // Routines row (`ctrl+a` `2` does the same thing). The header's "keeping
  // the daemon awake" is the claim that this runs with no TUI attached.
  await page.waitForTimeout(800)
  await click(page, 40, ROW.routines)
  await look(page, "ROUTINES", 15_000)
  await page.waitForTimeout(4_000)

  // Beat 2 — walking the rows swaps the detail box: each routine's prompt,
  // its precheck if it has one, and what its recent runs did. Row three is
  // paused, which is what an `e` toggle looks like from the list.
  await press(page, "j")
  await page.waitForTimeout(2_400)
  await press(page, "j")
  await page.waitForTimeout(2_800)

  // Beat 3 — pause and resume, on camera. `e` is how a schedule is silenced
  // without losing it; the row says `paused` and the daemon-hold header
  // follows the enabled set.
  await press(page, "e")
  await page.waitForTimeout(1_800)
  await press(page, "e")
  await page.waitForTimeout(1_800)
  await press(page, "k", "k")
  await page.waitForTimeout(1_200)

  // Beat 4 — composing one. Fields are walked with tab (name → repo →
  // prompt → schedule → confirm); the repo is a picker over saved projects.
  await press(page, "n")
  await look(page, "New routine", 10_000)
  await page.waitForTimeout(1_200)
  await typeText(page, NEW_ROUTINE.name)
  await press(page, "tab") // → repo
  await page.waitForTimeout(1_000)
  await press(page, "tab") // → prompt
  await typeText(page, NEW_ROUTINE.prompt)
  await page.waitForTimeout(1_000)

  // Beat 5 — the payoff. `←`/`→` pick a cron cell and `↑`/`↓` change it, and
  // the green line under the cells restates the schedule in the operator's
  // own clock every time — a cron you got wrong is visible before you save.
  await press(page, "tab") // → schedule
  await page.waitForTimeout(1_200)
  await press(page, "right") // → hour
  await page.waitForTimeout(600)
  await press(page, "up", "up", "up") // 09 → 12, and the preview follows
  await page.waitForTimeout(1_800)
  // The weekday cell moves and comes BACK: the point is that ↑/↓ edit the
  // highlighted cell, and the take still has to land on a schedule the
  // routine's own name claims.
  await press(page, "right", "right", "right") // → weekday
  await page.waitForTimeout(600)
  await press(page, "down")
  await page.waitForTimeout(1_400)
  await press(page, "up")
  await page.waitForTimeout(2_200)

  // Beat 6 — create it. The row lands in the list with its own next-run time,
  // computed from the cells that were just edited. The take ENDS on the list
  // rather than on the composer: the page is the subject.
  await press(page, "tab") // → confirm
  await page.waitForTimeout(800)
  await press(page, "enter")
  await look(page, NEW_ROUTINE.name, 10_000)
  await page.waitForTimeout(5_000)
}

if (!args.includes("--encode-only")) {
  await rm(workDir, { recursive: true, force: true })
  await mkdir(workDir, { recursive: true })
  await record(workDir, storyboard)
  removeComposedRoutine()
}
// `startAt` drops the harness settling on an empty workspace before the first
// click — a poster frame of "no task selected" undersells the page the video
// is about.
await encode({ workDir, outDir, name: "routines", speed: SPEED, startAt: 1.6 })
