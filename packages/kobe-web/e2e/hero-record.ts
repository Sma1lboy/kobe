/**
 * `bun e2e/hero-record.ts [--out=dir]` — record the README demo through the
 * sanctioned `/harness` path (`hero-serve.ts` must be running), then encode it
 * to `demo.mp4` + `demo.gif`.
 *
 * What it films is the pitch itself: two tasks alive at once, each on its own
 * worktree and branch, both driven from one TUI — a real follow-up typed into
 * each, real turns running side by side, and the diff of the work at the end.
 * Every pixel is the product's own rendering; nothing is staged in a mock.
 *
 * The turns are REAL, so the recording is nondeterministic and costs quota.
 * Waits are therefore advisory: a beat that never matches its marker times out
 * and the storyboard moves on, because a half-recorded demo is worth more than
 * a hung capture.
 *
 * Browser/PTY plumbing and the ffmpeg encode live in `hero-capture.ts`; this
 * file is only the storyboard. The kanban feature demo is `hero-kanban.ts`.
 */

import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { Page } from "@playwright/test"
import { REPO_ROOT, click, encode, press, record, type as typeText } from "./hero-capture.ts"

const args = process.argv.slice(2)
const outDir = resolve(args.find((arg) => arg.startsWith("--out="))?.slice(6) ?? join(REPO_ROOT, "docs", "assets"))
const workDir = join(REPO_ROOT, ".scratch", "hero-record")
/** Real seconds per delivered second. A live turn is minutes; a README is not. */
const SPEED = Number(args.find((arg) => arg.startsWith("--speed="))?.slice(8) ?? 4)

/** Sidebar row centres at 1280×800 — rows are 16px apart under the header. */
const ROW = { taskA: 215, taskB: 247, routines: 103 } as const
const COMPOSER = { x: 600, y: 711 } as const

async function storyboard(page: Page): Promise<void> {
  // Beat 1 — one task's finished turn: its own branch, its own commit.
  await click(page, 80, ROW.taskA)
  await page.waitForTimeout(4_000)

  // Beat 2 — a follow-up typed into that live session. `ctrl+u` first: the
  // composer is the engine's, and whatever a previous take left in it stays.
  await click(page, COMPOSER.x, COMPOSER.y)
  await press(page, "ctrl+u")
  await typeText(page, "Add a test for the timeout, then commit.")
  await press(page, "enter")

  // Beat 3 — it works while we walk away. A fixed hold, not a marker wait:
  // the transcript already contains every phrase a finished turn prints, so a
  // `look` here would return instantly and film nothing.
  await page.waitForTimeout(90_000)

  // Beat 4 — the second task, mid-flight the whole time, on its own worktree
  // and branch. This is the claim the whole product rests on.
  await click(page, 80, ROW.taskB)
  await page.waitForTimeout(9_000)

  // Beat 5 — and the work nobody has to sit through: scheduled prompts that
  // spawn their own tasks.
  await click(page, 40, ROW.routines)
  await page.waitForTimeout(6_000)

  // Beat 6 — back to the agent, which has been working the entire time.
  await click(page, 80, ROW.taskA)
  await page.waitForTimeout(10_000)
}

/** Re-encode the take already on disk — the storyboard costs real turns. */
if (!args.includes("--encode-only")) {
  await rm(workDir, { recursive: true, force: true })
  await mkdir(workDir, { recursive: true })
  await record(workDir, storyboard)
}
await encode({ workDir, outDir, name: "demo", speed: SPEED })
