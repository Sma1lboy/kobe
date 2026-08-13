/**
 * `bun run visual:shot [--out=path] [--scale=N] [token…]` — one ad-hoc
 * screenshot of the real OpenTUI through the warm harness (`visual:serve`
 * must be running). Tokens are applied in order: `text:…` types literally,
 * `wait:<ms>` pauses (for a beat that needs an engine to finish working),
 * everything else is a key chord (`ctrl+h`, `c`, `enter`, `down`…). No tokens
 * = the start view. `--scale` sets the device pixel ratio — the viewport stays
 * 1280×800 so the TUI keeps its cell grid, only the raster gets denser, which
 * is what a docs/README asset needs (`--scale=2` → a 2560×1600 PNG).
 *
 *   bun run visual:shot -- ctrl+a c            # Kanban board (prefix chord)
 *   bun run visual:shot -- ctrl+a c n "text:Draft title"
 *   bun run visual:shot -- --scale=2 --out=docs/assets/workspace.png
 */

import { resolve } from "node:path"
import { chromium } from "@playwright/test"
import { VISUAL_PTY_PORT, VISUAL_WEB_PORT } from "./visual-fixture.ts"

const KEY_NAMES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
}
const MODIFIERS: Record<string, string> = { ctrl: "Control", alt: "Alt", shift: "Shift", cmd: "Meta", meta: "Meta" }

function chord(token: string): string {
  const parts = token.toLowerCase().split("+")
  const key = parts.pop() ?? ""
  const mods = parts.map((part) => MODIFIERS[part] ?? part)
  return [...mods, KEY_NAMES[key] ?? (key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1))].join("+")
}

const args = process.argv.slice(2)
const outArg = args.find((arg) => arg.startsWith("--out="))?.slice(6)
const out = resolve(outArg ?? "test-results/visual-shot.png")
const scaleArg = args.find((arg) => arg.startsWith("--scale="))?.slice(8)
const deviceScaleFactor = scaleArg === undefined ? 1 : Number(scaleArg)
if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
  throw new Error(`--scale must be a positive number, got ${JSON.stringify(scaleArg)}`)
}
const tokens = args.filter((arg) => !arg.startsWith("--"))
const runId = `shot-${Date.now()}`

const browser = await chromium.launch({ headless: true }).catch((error: unknown) => {
  throw new Error(`chromium launch failed: ${error instanceof Error ? error.message : String(error)}`)
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor })
  await page.goto(`http://localhost:${VISUAL_WEB_PORT}/harness?run=${runId}`).catch(() => {
    throw new Error(`no server on :${VISUAL_WEB_PORT} — start \`bun run visual:serve\` first`)
  })
  const harness = page.getByTestId("opentui-harness")
  await harness.waitFor({ timeout: 10_000 })
  // TUI takeover: the fixture project row is the workspace's earliest stable
  // marker (the tree sidebar, default since the worktree tree landed, never
  // prints the old PROJECTS header this script used to wait for).
  const buffer = page.getByTestId("opentui-buffer")
  await page.waitForFunction(
    (el) => el?.textContent?.includes("fixture-repo"),
    await buffer.elementHandle(),
    { timeout: 45_000 },
  )
  // Click the sidebar's EMPTY lower area — (24, 24) would land on the tree's
  // project header row (same re-anchor rationale as sandbox.spec.ts).
  await page.getByTestId("opentui-terminal").click({ position: { x: 24, y: 400 } })
  for (const token of tokens) {
    if (token.startsWith("text:")) await page.keyboard.type(token.slice(5))
    else if (token.startsWith("wait:")) await page.waitForTimeout(Number(token.slice(5)))
    else await page.keyboard.press(chord(token))
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(600)
  await page.screenshot({ path: out })
  await page.request
    .post(`http://127.0.0.1:${VISUAL_PTY_PORT}/pty/close`, { data: { tab: `visual-${runId}` } })
    .catch(() => {})
  console.log(out)
} finally {
  await browser.close()
}
