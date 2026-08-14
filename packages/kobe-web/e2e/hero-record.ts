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
 * Encoding rides Remotion's bundled ffmpeg (`bun x remotion ffmpeg`) from
 * `packages/branding` — the repo has no system ffmpeg, and Playwright's build
 * carries neither h264 nor the gif palette filters.
 */

import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { type Page, chromium } from "@playwright/test"
import { HERO_PTY_PORT, HERO_WEB_PORT } from "./hero-env.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../../..")
const BRANDING = join(REPO_ROOT, "packages", "branding")
const args = process.argv.slice(2)
const outDir = resolve(args.find((arg) => arg.startsWith("--out="))?.slice(6) ?? join(REPO_ROOT, "docs", "assets"))
const workDir = join(REPO_ROOT, ".scratch", "hero-record")
/** Real seconds per delivered second. A live turn is minutes; a README is not. */
const SPEED = Number(args.find((arg) => arg.startsWith("--speed="))?.slice(8) ?? 4)

const KEYS: Record<string, string> = { enter: "Enter", esc: "Escape", up: "ArrowUp", down: "ArrowDown" }
const MODS: Record<string, string> = { ctrl: "Control", alt: "Alt", shift: "Shift" }
function chord(token: string): string {
  const parts = token.toLowerCase().split("+")
  const key = parts.pop() ?? ""
  return [...parts.map((part) => MODS[part] ?? part), KEYS[key] ?? key].join("+")
}

async function press(page: Page, ...tokens: string[]): Promise<void> {
  for (const token of tokens) {
    await page.keyboard.press(chord(token))
    await page.waitForTimeout(400)
  }
}

/**
 * Pane switching is done by CLICKING the row, not by the `ctrl+a` prefix.
 * The prefix is a two-stroke sequence, and while an engine is streaming into
 * the pane the second stroke gets starved: two takes were lost to a storyboard
 * that thought it had moved to the sidebar and typed its whole navigation —
 * `kkkkjjjl` — into a chat composer. A click cannot half-happen.
 */
async function click(page: Page, x: number, y: number): Promise<void> {
  await page.getByTestId("opentui-terminal").click({ position: { x, y } })
  await page.waitForTimeout(800)
}

/** Sidebar row centres at 1280×800 — rows are 16px apart under the header. */
const ROW = { taskA: 215, taskB: 247, routines: 103 } as const
const COMPOSER = { x: 600, y: 711 } as const

/**
 * Type a prompt and PROVE it landed. Keystrokes are delivered into a live
 * xterm that is simultaneously rendering another session's output, and a burst
 * gets truncated mid-word — the first take froze on a half-typed prompt that
 * was never submitted, and the recording sat on it for a minute and a half.
 * So: type slowly, read the composer back out of the buffer, and retype once
 * from a cleared line if the tail is missing.
 */
async function type(page: Page, text: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.keyboard.type(text, { delay: 80 })
    await page.waitForTimeout(900)
    if (await look(page, text.slice(-14), 5_000)) return
    await press(page, "ctrl+u")
  }
  console.error(`[hero:record] prompt never echoed: ${JSON.stringify(text)}`)
}

/** Advisory wait: returns false instead of failing the whole recording. */
async function look(page: Page, needle: string, timeout = 60_000): Promise<boolean> {
  const buffer = await page.getByTestId("opentui-buffer").elementHandle()
  try {
    await page.waitForFunction(
      ([el, text]) => (el as Element | null)?.textContent?.includes(text as string) ?? false,
      [buffer, needle] as const,
      { timeout },
    )
    return true
  } catch {
    console.error(`[hero:record] never saw ${JSON.stringify(needle)} — moving on`)
    return false
  }
}

function ffmpeg(argv: readonly string[]): void {
  const proc = Bun.spawnSync(["bun", "x", "remotion", "ffmpeg", ...argv], { cwd: BRANDING, stdio: ["ignore", "pipe", "pipe"] })
  if (proc.exitCode !== 0) throw new Error(`ffmpeg failed: ${new TextDecoder().decode(proc.stderr).slice(-2000)}`)
}

/** Re-encode the take already on disk — the storyboard costs real turns. */
const encodeOnly = args.includes("--encode-only")
if (!encodeOnly) {
  await rm(workDir, { recursive: true, force: true })
  await mkdir(workDir, { recursive: true })
  await record()
}

async function record(): Promise<void> {
const runId = `rec-${Date.now()}`
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: workDir, size: { width: 1280, height: 800 } },
})
try {
  const page = await context.newPage()
  await page.goto(`http://localhost:${HERO_WEB_PORT}/harness?run=${runId}`)
  await page.getByTestId("opentui-harness").waitFor({ timeout: 15_000 })
  await look(page, "orbit-sdk", 60_000)
  await page.getByTestId("opentui-terminal").click({ position: { x: 24, y: 400 } })
  await page.waitForTimeout(2_000)

  // Beat 1 — one task's finished turn: its own branch, its own commit.
  await click(page, 80, ROW.taskA)
  await page.waitForTimeout(4_000)

  // Beat 2 — a follow-up typed into that live session. `ctrl+u` first: the
  // composer is the engine's, and whatever a previous take left in it stays.
  await click(page, COMPOSER.x, COMPOSER.y)
  await press(page, "ctrl+u")
  await type(page, "Add a test for the timeout, then commit.")
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

  await page.request.post(`http://127.0.0.1:${HERO_PTY_PORT}/pty/close`, { data: { tab: `visual-${runId}` } }).catch(() => {})
} finally {
  await context.close()
  await browser.close()
}
}

const recorded = (await readdir(workDir)).find((name) => name.endsWith(".webm"))
if (!recorded) throw new Error(`no video written to ${workDir}`)
const source = join(workDir, "demo.webm")
if (recorded !== "demo.webm") await rename(join(workDir, recorded), source)

await mkdir(outDir, { recursive: true })
const palette = join(workDir, "palette.png")
// The speed-up is a TIMESTAMP rescale (`-itsscale`), not a `setpts` filter,
// and the gif's frame rate is an output `-r`, not an `fps` filter: Remotion's
// ffmpeg is built `--disable-filters` with a small whitelist, and neither
// `setpts` nor `fps` is in it. `scale`, `palettegen` and `paletteuse` are.
const cut = ["-itsscale", String(1 / SPEED)]
ffmpeg([
  "-y",
  ...cut,
  "-i",
  source,
  "-vf",
  "scale=1280:-2",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-crf",
  "24",
  "-r",
  "24",
  "-movflags",
  "+faststart",
  join(outDir, "demo.mp4"),
])
// GIF sizing is a README constraint, not a taste one: it autoplays inline on
// the repo page, so it stays under ~8MB. Half the width of the mp4, 10fps and
// a 96-colour palette get there while the terminal grid is still readable.
const gifScale = "scale=800:-1:flags=lanczos"
ffmpeg(["-y", ...cut, "-i", source, "-vf", `${gifScale},palettegen=max_colors=96`, "-update", "1", palette])
ffmpeg([
  "-y",
  ...cut,
  "-i",
  source,
  "-i",
  palette,
  "-lavfi",
  `[0:v]${gifScale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
  "-r",
  "10",
  "-loop",
  "0",
  join(outDir, "demo.gif"),
])
console.log(join(outDir, "demo.mp4"))
console.log(join(outDir, "demo.gif"))
