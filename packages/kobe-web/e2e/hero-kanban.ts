/**
 * `bun e2e/hero-kanban.ts [--out=dir] [--speed=N]` — record the KANBAN
 * feature demo through the sanctioned `/harness` path (`hero-serve.ts` must
 * be running, against a board seeded by `hero-issues.ts`), then encode it to
 * `kanban.mp4` + `kanban.gif`.
 *
 * What it films is the board's own claim: the daemon-owned issue store as
 * Backlog / In progress / Done, a story you can open and edit, a story you
 * can file from the TUI — and a card that MOVES because an agent moved it.
 * That last beat is a real `rove api issue-update --task` fired from outside
 * the TUI while the page is open, which is exactly the call an agent makes;
 * the board's poll picks it up on camera. Nothing is staged in a mock.
 *
 * Unlike `hero-record.ts` this storyboard costs NO engine quota and is
 * deterministic — no live turn is involved. It deliberately stops short of
 * the drawer's Start action: a story started into its own worktree boots the
 * engine in a directory Claude Code has never seen, which raises the
 * first-run folder-trust prompt (see `hero-seed.ts`) and would film a modal
 * instead of the product. The drawer's engine / workspace / after-start
 * controls are still shown, so the capability is on screen.
 *
 * NOT idempotent: beat 4 files a real story and beat 5 creates the task it
 * gets linked to. Re-shoot from a clean board — `bun e2e/hero-fixture.ts
 * --fresh && bun e2e/hero-issues.ts` — or the extra cards pile up.
 */

import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { Page } from "@playwright/test"
import { REPO_ROOT, click, encode, look, press, record, type as typeText } from "./hero-capture.ts"
import { HERO_REPO } from "./hero-env.ts"
import { heroApi } from "./hero-fixture.ts"

const args = process.argv.slice(2)
const outDir = resolve(args.find((arg) => arg.startsWith("--out="))?.slice(6) ?? join(REPO_ROOT, "docs", "assets"))
const workDir = join(REPO_ROOT, ".scratch", "hero-kanban")
/** Real seconds per delivered second. Slower than the README demo's 4×: this
 *  one is read (titles, fields, a card moving), not skimmed. */
const SPEED = Number(args.find((arg) => arg.startsWith("--speed="))?.slice(8) ?? 3)

/** The story filed on camera, then handed to an "agent" in the next beat. */
const NEW_STORY = {
  title: "Warn on unbounded page size",
  body: "Reject page sizes over 500 instead of truncating silently.",
} as const

/** Sidebar row centres at 1280×800 — the pages sit above the project tree. */
const ROW = { kanban: 87 } as const

/**
 * The agent's half of the story: link the freshly filed issue to a task.
 * The LINK is what puts a card in the In-progress column, and
 * `rove api issue-update --task` is the documented way an agent moves its
 * own card — so the move on screen is the real mechanism, not a repaint.
 */
function agentPicksUpStory(): void {
  type Issue = { id: number; title: string }
  const issues = (heroApi(["issue-list", "--repo", HERO_REPO]) as { issues?: Issue[] }).issues ?? []
  const story = issues.find((issue) => issue.title === NEW_STORY.title)
  if (!story) {
    console.error(`[hero:kanban] the intake beat filed no story — skipping the agent move`)
    return
  }
  // Same `#id title` shape a story-spawned task carries in the sidebar.
  const created = heroApi(["add", "--repo", HERO_REPO, "--title", `#${story.id} ${story.title}`]) as {
    taskId?: string
  }
  if (!created.taskId) throw new Error("no task created for the agent move")
  heroApi(["issue-update", "--repo", HERO_REPO, "--id", String(story.id), "--task", created.taskId])
  console.log(`[hero:kanban] #${story.id} linked to ${created.taskId} — in progress`)
}

async function storyboard(page: Page): Promise<void> {
  // Beat 1 — the board, opened the discoverable way: the sidebar's own
  // Kanban row (`ctrl+a` `1` does the same thing). Barely a hold before the
  // click on purpose — the take opens on a workspace with nothing selected
  // yet, and that frame is also the video's poster.
  await page.waitForTimeout(800)
  await click(page, 40, ROW.kanban)
  await look(page, "In progress", 15_000)
  await page.waitForTimeout(4_000)

  // Beat 2 — the card cursor walks out of In progress and down the backlog.
  await press(page, "left")
  await page.waitForTimeout(700)
  for (let step = 0; step < 3; step += 1) {
    await press(page, "down")
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(1_200)

  // Beat 3 — the detail drawer: the story is editable, and it carries the
  // configuration a session would start with (engine, where it runs, and
  // whether you follow it or stay on the board).
  await press(page, "enter")
  await look(page, "WORKSPACE", 10_000)
  await page.waitForTimeout(3_000)
  await press(page, "shift+tab") // → ENGINE
  await page.waitForTimeout(600)
  await press(page, "right", "right", "left", "left") // Codex, Copilot, back to Claude
  await page.waitForTimeout(600)
  await press(page, "tab") // → WORKSPACE
  await page.waitForTimeout(600)
  await press(page, "down", "down", "up", "up") // the three placements, back to the default
  await page.waitForTimeout(1_500)
  await press(page, "esc") // saves the (unchanged) draft and closes
  await page.waitForTimeout(2_000)

  // Beat 4 — filing a story from the TUI. `ctrl+s` files it without starting
  // anything; enter would file it AND start the engine.
  await press(page, "n")
  await look(page, "NEW STORY", 10_000)
  await page.waitForTimeout(1_000)
  await typeText(page, NEW_STORY.title)
  await press(page, "tab")
  await typeText(page, NEW_STORY.body)
  await page.waitForTimeout(1_000)
  await press(page, "ctrl+s")
  await look(page, "unbounded page size", 10_000)
  await page.waitForTimeout(2_500)

  // Beat 5 — an agent picks the story up from outside the TUI. The board is
  // still open; its poll moves the card, and the task shows up in the sidebar.
  agentPicksUpStory()
  // Long enough for the poll (5s) to land the move, plus a hold to read the
  // new column counts and the task the sidebar just grew. The board is the
  // subject, so the take ENDS here rather than on `esc` — closing the page
  // lands on a task with no worktree, i.e. an empty pane for a final frame.
  await page.waitForTimeout(14_000)
}

if (!args.includes("--encode-only")) {
  await rm(workDir, { recursive: true, force: true })
  await mkdir(workDir, { recursive: true })
  await record(workDir, storyboard)
}
// `startAt` drops the harness settling on an empty workspace before the
// first click — a poster frame of "no task selected" undersells the page
// the video is about.
await encode({ workDir, outDir, name: "kanban", speed: SPEED, startAt: 1.6 })
