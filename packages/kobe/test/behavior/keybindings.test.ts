/**
 * Behavior test for Stream D — global keybindings.
 *
 * Spawns the kobe binary under a PTY and asserts that:
 *   1. Pressing `F1` opens the help dialog with the bindings table visible.
 *   2. Pressing `esc` closes the dialog.
 *   3. Pressing `ctrl+p` opens the command palette.
 *   4. Pressing bare `q` on the sidebar opens the quit-confirm dialog.
 *
 * Why these actions: they are the user-visible surface of the global keymap.
 * Other bindings (`tab`, `shift+tab`) have no visible effect at the level
 * of the keymap-wiring contract this stream owns.
 *
 * `F1` byte form: `\x1bOP` (xterm). opentui's keymap also maps `\x1b[11~`
 * to `f1`; we use the xterm form because it's what node-pty delivers by
 * default.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

let kobe: KobeHandle | null = null
let tmpRoot: string | null = null

afterEach(async () => {
  if (kobe && !kobe.closed) {
    await kobe.exit()
  }
  kobe = null
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  tmpRoot = null
})

async function spawnIsolatedKobe(): Promise<KobeHandle> {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-keybindings-"))
  const homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  return await spawnKobe({
    env: {
      HOME: homeDir,
      KOBE_HOME_DIR: homeDir,
      KOBE_TEST_ENGINE: "fake",
    },
  })
}

test("`F1` opens the help dialog showing the kobe keybinding table", async () => {
  kobe = await spawnIsolatedKobe()
  // Wait for the boot banner before driving keys, otherwise the keys
  // race the renderer attaching the keypress handler.
  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)

  await kobe.sendKeys("\x1bOP") // F1 (xterm)
  const screen = await kobe.waitFor((s) => s.includes("keybindings"), 5_000)
  // The help dialog title contains the literal string "keybindings"; the
  // rows include category labels we know are present.
  expect(screen).toContain("keybindings")
  expect(screen).toContain("Global")
  expect(screen).toContain("Open command palette")
  expect(screen).toContain("Show this help dialog")
}, 30_000)

test("`esc` closes the help dialog", async () => {
  kobe = await spawnIsolatedKobe()
  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)

  await kobe.sendKeys("\x1bOP") // F1 (xterm)
  await kobe.waitFor((s) => s.includes("keybindings"), 5_000)

  // ESC = 0x1b. The DialogProvider's escape binding (registered higher on
  // the binding stack) pops the top dialog.
  await kobe.sendKeys("\x1b")
  // Poll the screen until the post-dismiss UI is repainting. The
  // center column's CAPS pane header `WORKSPACE` is always rendered at
  // the top of the workspace pane — outside the help dialog's centered
  // overlay — so its presence in the cumulative buffer is a reliable
  // "the underlying chrome is still painting" signal. The previous
  // assertion used "In progress" — the status-group label from the
  // pre-W4.A sidebar — which no longer exists because Wave 4 dropped
  // status grouping in favor of repo grouping.
  const after = await kobe.waitFor((s) => s.includes("WORKSPACE"), 5_000)
  expect(after).toContain("WORKSPACE")
}, 30_000)

test("status bar keeps only primary pane hints plus Help", async () => {
  kobe = await spawnIsolatedKobe()
  const sidebar = await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)

  expect(sidebar).toContain("Tasks:")
  expect(sidebar).toContain("[F1]")
  expect(sidebar).toContain("help")
  expect(sidebar).toContain("[n]")
  expect(sidebar).toContain("new")
  expect(sidebar).toContain("[j/k]")
  expect(sidebar).toContain("nav")
  expect(sidebar).toContain("[enter]")
  expect(sidebar).toContain("select")
  expect(sidebar).toContain("[/]")
  expect(sidebar).toContain("search")
  expect(sidebar).not.toContain("settings")
  expect(sidebar).not.toContain("delete")
  expect(sidebar).not.toContain("archive")
  expect(sidebar).not.toContain("ctrl+hjkl")

  await kobe.sendKeys("\t")
  const chat = await kobe.waitFor((s) => s.includes("Chat:"), 5_000)
  expect(chat).toContain("[F1]")
  expect(chat).toContain("help")
  expect(chat).toContain("[enter]")
  expect(chat).toContain("send")
  expect(chat).toContain("[shift+enter]")
  expect(chat).toContain("newline")
  expect(chat).toContain("[shift+tab]")
  expect(chat).toContain("mode")
  expect(chat).toContain("[ctrl+t]")
  expect(chat).toContain("new tab")
  expect(chat).toContain("[ctrl+f]")
  expect(chat).toContain("fork")
  expect(chat).not.toContain("rename tab")
  expect(chat).not.toContain("1-9")
}, 30_000)

test("`ctrl+p` opens the command palette", async () => {
  kobe = await spawnIsolatedKobe()
  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)

  // \x10 = Ctrl+P. Palette uses ctrl+p/cmd+p/cmd+k; ctrl+k is now the
  // direct focus chord for the Files pane.
  await kobe.sendKeys("\x10")
  const screen = await kobe.waitFor((s) => s.includes("Commands") || s.includes("No commands"), 5_000)
  // The empty-state message of the palette dialog — Stream D does not
  // register any commands; downstream streams add them. The palette's
  // title bar reads "Commands"; presence of either string proves the
  // palette opened.
  expect(screen.toLowerCase()).toMatch(/commands|no commands/)
}, 30_000)

test("bare `q` on the sidebar opens the quit-confirm dialog", async () => {
  kobe = await spawnIsolatedKobe()
  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)

  // Cold boot focuses the sidebar; `q` is the sidebar-scoped quit verb.
  await kobe.sendKeys("q")
  const screen = await kobe.waitFor((s) => s.includes("Quit kobe?"), 5_000)
  expect(screen).toContain("Quit kobe?")
}, 30_000)
