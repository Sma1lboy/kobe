/**
 * `bun e2e/hero-shot.ts [--out=path] [--scale=N] [--width=N] [--height=N]
 * [token…]` — one README/docs still of the real OpenTUI, through the same
 * sanctioned `/harness` path as `visual:shot`, but pointed at the richer hero
 * stack (`hero-serve.ts` must be running).
 *
 * Tokens are applied in order: `text:…` types literally, `wait:<ms>` pauses,
 * anything else is a key chord. `--scale` only raises the device pixel ratio —
 * the cell grid is decided by `--width`/`--height`, so a 2× docs still lays
 * out exactly like the 1× screen it was framed on.
 *
 *   bun e2e/hero-shot.ts --scale=2 --out=../../docs/assets/workspace.png
 *   bun e2e/hero-shot.ts --width=420 --out=../../docs/assets/narrow-sidebar.png
 */

import { resolve } from "node:path"
import { chromium } from "@playwright/test"
import { HERO_PTY_PORT, HERO_WEB_PORT } from "./hero-env.ts"

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
function flag(name: string, fallback: number): number {
  const raw = args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number, got ${raw}`)
  return value
}

const out = resolve(args.find((arg) => arg.startsWith("--out="))?.slice(6) ?? "test-results/hero-shot.png")
const deviceScaleFactor = flag("scale", 1)
const width = flag("width", 1280)
const height = flag("height", 800)
const tokens = args.filter((arg) => !arg.startsWith("--"))
const runId = `hero-${Date.now()}`

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor })
  await page.goto(`http://localhost:${HERO_WEB_PORT}/harness?run=${runId}`).catch(() => {
    throw new Error(`no server on :${HERO_WEB_PORT} — start \`bun e2e/hero-serve.ts\` first`)
  })
  await page.getByTestId("opentui-harness").waitFor({ timeout: 15_000 })
  // TUI takeover marker: the hero repo's own row in the sidebar tree.
  const buffer = page.getByTestId("opentui-buffer")
  await page.waitForFunction((el) => el?.textContent?.includes("orbit-sdk"), await buffer.elementHandle(), {
    timeout: 60_000,
  })
  // Click low in the sidebar rail — (24, 24) would land on the project header.
  await page.getByTestId("opentui-terminal").click({ position: { x: 24, y: Math.min(400, height - 80) } })
  for (const token of tokens) {
    // Typed per keystroke: a burst types faster than the TUI mounts a freshly
    // opened input, and the leading characters land nowhere.
    if (token.startsWith("text:")) await page.keyboard.type(token.slice(5), { delay: 25 })
    else if (token.startsWith("wait:")) await page.waitForTimeout(Number(token.slice(5)))
    else await page.keyboard.press(chord(token))
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(1_200)
  await page.screenshot({ path: out })
  await page.request
    .post(`http://127.0.0.1:${HERO_PTY_PORT}/pty/close`, { data: { tab: `visual-${runId}` } })
    .catch(() => {})
  console.log(out)
} finally {
  await browser.close()
}
