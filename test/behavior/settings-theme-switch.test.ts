/**
 * Behavior test for the 0.1.0 settings dialog → theme switch flow.
 *
 * What this proves end-to-end:
 *
 *   1. The bare `,` shortcut from a non-input pane (cold-boot focus is
 *      the sidebar) opens the SettingsDialog and the General section is
 *      active by default.
 *   2. The theme picker renders the bundled themes in alpha order
 *      (`conductor` first, default-active because src/tui/app.tsx sets
 *      `DEFAULT_THEME = "conductor"`).
 *   3. Pressing ↓ + enter on the picker switches the active theme to
 *      `dracula` (the first non-default after the cold-boot cursor sits
 *      on the active row, then moves one step down).
 *   4. After closing the dialog, the KV store at
 *      `$HOME/.config/kobe/state.json` is rewritten with
 *      `activeTheme: "dracula"` — the most reliable proxy for "theme
 *      actually applied" since the persistence effect in app.tsx only
 *      fires when `themeCtx.selected` changes.
 *
 * Why we don't sniff the rendered colors: opentui paints RGBA into a
 * cell buffer and the PTY capture is plain text; extracting hex codes
 * would require parsing SGR sequences out of `captureRaw()` and is
 * fragile across terminal implementations. The KV write is the same
 * signal the app itself uses to round-trip the user's choice across
 * runs, so persistence == applied.
 *
 * KV path note: `src/tui/context/kv.tsx` joins
 * `homedir(), ".config", "kobe", "state.json"` with no
 * `KOBE_HOME_DIR` override (unlike the task index store). We override
 * `HOME` on the spawned PTY so the test never touches the real
 * `~/.config/kobe/state.json`. We ALSO set `KOBE_HOME_DIR` so the task
 * index store's `~/.kobe/tasks.json` lands in the same tmpdir — kobe
 * boots cleanly and the test stays hermetic.
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

test("settings dialog → theme switch persists to KV", async () => {
  // Hermetic HOME so the test never writes to the real
  // `~/.config/kobe/state.json`. KV reads `os.homedir()` directly,
  // which honors the `HOME` env var on POSIX.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-settings-"))
  const homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  const statePath = path.join(homeDir, ".config", "kobe", "state.json")

  kobe = await spawnKobe({
    env: {
      HOME: homeDir,
      // Same dir for the task index store so kobe boots fully
      // hermetic — see src/orchestrator/index/store.ts and
      // src/tui/app.tsx (`process.env.KOBE_HOME_DIR ?? homedir()`).
      KOBE_HOME_DIR: homeDir,
    },
    cols: 120,
    rows: 30,
  })

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)

  // Cold boot → sidebar is focused (see FocusProvider's default in
  // src/tui/context/focus.tsx). The bare `,` binding registered in
  // app.tsx is gated on `focusedPane() !== "workspace"`, so it fires
  // here.
  await kobe.sendKeys(",")

  // Dialog title is the literal string "Settings" (see
  // src/tui/component/settings-dialog.tsx). The General section
  // header "Theme" is rendered by default. Use whitespace-collapsed
  // matching because opentui wraps text and may drop spaces at wrap
  // points in the captured frame.
  const dialogScreen = await kobe.waitFor((s) => {
    const flat = s.replace(/\s+/g, "")
    return flat.includes("Settings") && flat.includes("Theme")
  }, 5_000)
  const flatDialog = dialogScreen.replace(/\s+/g, "")
  expect(flatDialog).toContain("Settings")
  expect(flatDialog).toContain("Theme")
  // Sentinel that only appears in the General section's theme picker
  // body — proves we landed on General, not Dev.
  expect(flatDialog).toContain("Transparentbackground")

  // Bundled theme names sorted alphabetically (see SettingsDialog's
  // `themeNames` memo). The visible list contains all six.
  for (const name of ["conductor", "dracula", "nord", "opencode", "tokyonight"]) {
    expect(flatDialog).toContain(name)
  }

  // The cursor starts on the currently-active theme (`conductor` —
  // app.tsx sets DEFAULT_THEME there). Press ↓ once to land on
  // `dracula`, the next entry in alpha-sorted order.
  await kobe.sendKeys("\x1b[B") // arrow down
  // Apply the highlighted theme. The `return` binding in
  // settings-dialog.tsx calls `themeCtx.set(name)`.
  await kobe.sendKeys("\r")
  // Close the dialog. DialogProvider's escape binding pops the top
  // dialog (resolves the `onClose` promise the SettingsDialog passed
  // to its show() helper).
  await kobe.sendKeys("\x1b")

  // Wait until the underlying chrome is repainting — the WORKSPACE
  // pane header is always rendered outside any centered overlay, so
  // its presence post-dismiss is a reliable settle signal.
  await kobe.waitFor((s) => s.includes("WORKSPACE"), 5_000)

  // Persistence proof: the `createEffect` in app.tsx writes
  // `activeTheme` to KV every time `themeCtx.selected` changes, and
  // KV debounces writes by 250ms (see kv.tsx WRITE_DEBOUNCE_MS).
  // Poll up to ~3s for the file to appear and contain the new value.
  let persisted: { activeTheme?: unknown } | null = null
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (fs.existsSync(statePath)) {
      try {
        const text = fs.readFileSync(statePath, "utf8")
        const parsed = JSON.parse(text) as { activeTheme?: unknown }
        if (parsed && typeof parsed === "object" && parsed.activeTheme === "dracula") {
          persisted = parsed
          break
        }
      } catch {
        // mid-write race — keep polling
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(persisted).not.toBeNull()
  expect(persisted?.activeTheme).toBe("dracula")

  await kobe.exit()
}, 60_000)
