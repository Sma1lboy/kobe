/**
 * Shared driver for the hero VIDEO captures — the browser/PTY plumbing and
 * the ffmpeg encode that `hero-record.ts` (README demo) and `hero-kanban.ts`
 * (the kanban feature demo) both ride. Stills stay in `hero-shot.ts`.
 *
 * A storyboard file is then only its beats: what to click, what to type, and
 * how long to hold on each. Everything below is the part that must not drift
 * between two recordings of the same product.
 */

import { mkdir, readdir, rename } from "node:fs/promises"
import { join, resolve } from "node:path"
import { type Page, chromium } from "@playwright/test"
import { HERO_PTY_PORT, HERO_WEB_PORT } from "./hero-env.ts"

export const REPO_ROOT: string = resolve(import.meta.dirname, "../../..")
const BRANDING = join(REPO_ROOT, "packages", "branding")

const KEYS: Record<string, string> = {
  enter: "Enter",
  esc: "Escape",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  tab: "Tab",
}
const MODS: Record<string, string> = { ctrl: "Control", alt: "Alt", shift: "Shift" }

function chord(token: string): string {
  const parts = token.toLowerCase().split("+")
  const key = parts.pop() ?? ""
  return [...parts.map((part) => MODS[part] ?? part), KEYS[key] ?? key].join("+")
}

export async function press(page: Page, ...tokens: string[]): Promise<void> {
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
export async function click(page: Page, x: number, y: number): Promise<void> {
  await page.getByTestId("opentui-terminal").click({ position: { x, y } })
  await page.waitForTimeout(800)
}

/**
 * Type text and PROVE it landed. Keystrokes are delivered into a live xterm
 * that may be rendering another session's output, and a burst gets truncated
 * mid-word — the first README take froze on a half-typed prompt that was never
 * submitted. So: type slowly, read it back out of the buffer, and retype once
 * from a cleared line if the tail is missing.
 */
export async function type(page: Page, text: string, clear = "ctrl+u"): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.keyboard.type(text, { delay: 80 })
    await page.waitForTimeout(900)
    if (await look(page, text.slice(-14), 5_000)) return
    await press(page, clear)
  }
  console.error(`[hero:capture] text never echoed: ${JSON.stringify(text)}`)
}

/** Advisory wait: returns false instead of failing the whole recording. */
export async function look(page: Page, needle: string, timeout = 60_000): Promise<boolean> {
  const buffer = await page.getByTestId("opentui-buffer").elementHandle()
  try {
    await page.waitForFunction(
      ([el, text]) => (el as Element | null)?.textContent?.includes(text as string) ?? false,
      [buffer, needle] as const,
      { timeout },
    )
    return true
  } catch {
    console.error(`[hero:capture] never saw ${JSON.stringify(needle)} — moving on`)
    return false
  }
}

/**
 * Boot a fresh `/harness` browser PTY against the warm hero stack, wait for
 * the TUI to take the terminal over, hand the page to `storyboard`, and leave
 * a `.webm` in `workDir`. The takeover marker is the hero repo's own sidebar
 * row: until it renders, keystrokes land in a shell, not in the product.
 */
export async function record(workDir: string, storyboard: (page: Page) => Promise<void>): Promise<void> {
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
    await storyboard(page)
    await page.request.post(`http://127.0.0.1:${HERO_PTY_PORT}/pty/close`, { data: { tab: `visual-${runId}` } }).catch(() => {})
  } finally {
    await context.close()
    await browser.close()
  }
}

function ffmpeg(argv: readonly string[]): void {
  const proc = Bun.spawnSync(["bun", "x", "remotion", "ffmpeg", ...argv], {
    cwd: BRANDING,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (proc.exitCode !== 0) throw new Error(`ffmpeg failed: ${new TextDecoder().decode(proc.stderr).slice(-2000)}`)
}

/**
 * Encode the take in `workDir` to `<name>.mp4` + `<name>.gif` in `outDir`,
 * sped up `speed`× — real seconds per delivered second, because a live
 * session is minutes and a docs page is not.
 *
 * Encoding rides Remotion's bundled ffmpeg: the repo has no system ffmpeg,
 * and Playwright's build carries neither h264 nor the gif palette filters.
 * That build is also `--disable-filters` with a small whitelist, so the
 * speed-up is a TIMESTAMP rescale (`-itsscale`) and the gif frame rate is an
 * output `-r` — `setpts` and `fps` do not exist in it; `scale`, `palettegen`
 * and `paletteuse` do.
 */
export async function encode(opts: {
  readonly workDir: string
  readonly outDir: string
  readonly name: string
  readonly speed: number
  /** GIF width. A README gif autoplays inline, so it stays small. */
  readonly gifWidth?: number
  /**
   * Seconds to drop off the FRONT, in delivered (post-speed-up) time — the
   * take always opens on the harness settling into the TUI, and that frame
   * is also the video's poster. Output-side `-ss`, so it survives the
   * `-itsscale` rescale that stands in for the missing `setpts` filter.
   */
  readonly startAt?: number
}): Promise<void> {
  const recorded = (await readdir(opts.workDir)).find((file) => file.endsWith(".webm"))
  if (!recorded) throw new Error(`no video written to ${opts.workDir}`)
  const source = join(opts.workDir, `${opts.name}.webm`)
  if (recorded !== `${opts.name}.webm`) await rename(join(opts.workDir, recorded), source)

  await mkdir(opts.outDir, { recursive: true })
  const cut = ["-itsscale", String(1 / opts.speed)]
  const trim = opts.startAt ? ["-ss", String(opts.startAt)] : []
  const mp4 = join(opts.outDir, `${opts.name}.mp4`)
  ffmpeg([
    "-y",
    ...cut,
    "-i",
    source,
    ...trim,
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
    mp4,
  ])

  const palette = join(opts.workDir, `${opts.name}-palette.png`)
  const gifScale = `scale=${opts.gifWidth ?? 800}:-1:flags=lanczos`
  const gif = join(opts.outDir, `${opts.name}.gif`)
  ffmpeg(["-y", ...cut, "-i", source, ...trim, "-vf", `${gifScale},palettegen=max_colors=96`, "-update", "1", palette])
  ffmpeg([
    "-y",
    ...cut,
    "-i",
    source,
    "-i",
    palette,
    ...trim,
    "-lavfi",
    `[0:v]${gifScale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
    "-r",
    "10",
    "-loop",
    "0",
    gif,
  ])
  console.log(mp4)
  console.log(gif)
}
