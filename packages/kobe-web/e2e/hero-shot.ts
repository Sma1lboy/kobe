/**
 * One-off README hero screenshot through the sanctioned /harness path.
 * Assumes an isolated dev stack on :5323/:5325 (see /tmp/khero/kserve.sh).
 *
 *   bun e2e/hero-shot.ts [--out=path] [token…]
 *
 * Tokens follow visual-shot semantics: `text:…` types, all else key chords.
 */

import { resolve } from "node:path"
import { chromium } from "@playwright/test"

const WEB_PORT = Number.parseInt(process.env.HERO_WEB_PORT ?? "5323", 10)
const PTY_PORT = Number.parseInt(process.env.HERO_PTY_PORT ?? "5325", 10)
const WIDTH = Number.parseInt(process.env.HERO_WIDTH ?? "1600", 10)
const HEIGHT = Number.parseInt(process.env.HERO_HEIGHT ?? "1000", 10)

const KEY_NAMES: Record<string, string> = {
  enter: "Enter",
  esc: "Escape",
  tab: "Tab",
  space: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
}
const MODIFIERS: Record<string, string> = { ctrl: "Control", alt: "Alt", shift: "Shift", cmd: "Meta" }

function chord(token: string): string {
  const parts = token.toLowerCase().split("+")
  const key = parts.pop() ?? ""
  const mods = parts.map((part) => MODIFIERS[part] ?? part)
  return [...mods, KEY_NAMES[key] ?? (key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1))].join("+")
}

const args = process.argv.slice(2)
const out = resolve(args.find((a) => a.startsWith("--out="))?.slice(6) ?? "test-results/hero-shot.png")
const tokens = args.filter((a) => !a.startsWith("--"))
const runId = `hero-${Date.now()}`

const browser = await chromium.launch({ headless: true, channel: process.env.HERO_CHANNEL || undefined })
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 })
  await page.goto(`http://localhost:${WEB_PORT}/harness?run=${runId}`)
  await page.getByTestId("opentui-harness").waitFor({ timeout: 10_000 })
  const buffer = page.getByTestId("opentui-buffer")
  await page.waitForFunction((el) => el?.textContent?.includes("PROJECTS"), await buffer.elementHandle(), {
    timeout: 60_000,
  })
  await page.getByTestId("opentui-terminal").click({ position: { x: 24, y: 24 } })
  for (const token of tokens) {
    if (token.startsWith("text:")) await page.keyboard.type(token.slice(5))
    else await page.keyboard.press(chord(token))
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(2_000)
  await page.getByTestId("opentui-harness").screenshot({ path: out })
  await page.request.post(`http://127.0.0.1:${PTY_PORT}/pty/close`, { data: { tab: `visual-${runId}` } }).catch(() => {})
  console.log(out)
} finally {
  await browser.close()
}
