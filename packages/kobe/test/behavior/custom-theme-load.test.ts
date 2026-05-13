/**
 * Behavior test for user-installable themes.
 *
 * What this proves end-to-end:
 *
 *   1. Dropping a JSON file into `<KOBE_HOME_DIR>/.kobe/themes/<name>.json`
 *      causes kobe to register `<name>` in the theme registry at boot
 *      (via `loadUserThemes()` -> `addTheme()` in `startApp`).
 *   2. The settings dialog's theme picker shows the user theme alongside
 *      bundled themes — i.e. `themeCtx.all()` returns both sets, and
 *      `settings-dialog.tsx`'s `themeNames` memo lists them.
 *
 * What we DON'T assert:
 *   - The rendered colors. opentui paints RGBA into a cell buffer; the
 *     PTY capture is plain text. See settings-theme-switch.test.ts for
 *     the same caveat. The presence of the theme name in the picker is
 *     a faithful proxy: if it shows up, registration ran and the
 *     SolidJS reactivity flowed into the picker.
 *   - That switching to the user theme persists across boots. The KV
 *     write path is shared with bundled themes and already covered by
 *     `settings-theme-switch.test.ts`.
 *
 * Hermeticity: same pattern as settings-theme-switch.test.ts. We set
 * both `HOME` (so the KV store at `~/.config/kobe/state.json` lands in
 * tmp) and `KOBE_HOME_DIR` (so the loader and task index store also
 * live in tmp).
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

test("user theme dropped into ~/.kobe/themes/ appears in settings picker", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-custom-theme-"))
  const homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })

  // Drop a minimal but valid theme into the user themes dir BEFORE
  // spawning kobe. Loader is sync at boot, so this file is read
  // before ThemeProvider mounts.
  const themesDir = path.join(homeDir, ".kobe", "themes")
  fs.mkdirSync(themesDir, { recursive: true })
  fs.writeFileSync(
    path.join(themesDir, "aa-theme.json"),
    JSON.stringify({
      theme: {
        background: "#101010",
        text: "#abcdef",
        primary: "#ff00ff",
      },
    }),
  )

  kobe = await spawnKobe({
    env: {
      HOME: homeDir,
      KOBE_HOME_DIR: homeDir,
      KOBE_TEST_ENGINE: "fake",
    },
    cols: 120,
    rows: 30,
  })

  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)

  // Open settings via ctrl+, — same xterm modifyOtherKeys escape used
  // by settings-theme-switch.test.ts. Cold-boot focus is the sidebar,
  // which doesn't intercept this binding.
  await kobe.sendKeys("\x1b[27;5;44~")
  await kobe.sendKeys("l")

  // Wait until the dialog's theme picker is on screen. Use whitespace-
  // collapsed matching because opentui wraps text and may drop spaces
  // at wrap points in the captured frame.
  await kobe.waitFor((s) => {
    const flat = s.replace(/\s+/g, "")
    return flat.includes("Settings") && flat.includes("Theme")
  }, 5_000)

  // Use a name that sorts before bundled themes so the row is visible
  // even in the compact PTY viewport used by behavior tests.
  const screen = await kobe.waitFor((s) => s.replace(/\s+/g, "").includes("aa-theme"), 5_000)
  const flat = screen.replace(/\s+/g, "")

  // Sanity: our user theme shows up in the settings picker.
  expect(flat).toContain("aa-theme")

  // Close the dialog cleanly so teardown doesn't race with paint.
  await kobe.sendKeys("\x1b")
  await kobe.waitFor((s) => s.includes("WORKSPACE"), 5_000)
  await kobe.exit()
}, 60_000)
