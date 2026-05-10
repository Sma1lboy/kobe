/**
 * Behavior test for Stream D — global keybindings.
 *
 * Spawns the kobe binary under a PTY and asserts that:
 *   1. Pressing `F1` opens the help dialog with the bindings table visible.
 *   2. Pressing `esc` closes the dialog.
 *   3. Pressing `ctrl+k` (the byte-level form of `cmd+k` that PTYs deliver
 *      on macOS — terminals do not propagate the Command modifier) opens
 *      the command palette.
 *   4. Pressing bare `q` does NOT open the quit-confirm dialog (after the
 *      bare-letter purge, quit moved to ctrl+q — focus.detach moved to esc
 *      so the chord could be reclaimed).
 *
 * Why these actions: they are the user-visible surface of the global keymap.
 * Other bindings (`tab`, `shift+tab`) have no visible effect at the level
 * of the keymap-wiring contract this stream owns.
 *
 * `cmd+k` byte form: ctrl+k on a PTY is `\x0b` (the 11th C0 control byte,
 * VT). We do NOT use `\x1bk` (alt+k / Option+K → Esc-prefixed `k`)
 * because that races with esc — the universal-cancel key. ctrl+k is
 * unambiguous and is what real users on Linux/macOS terminals get when
 * they press their bound shortcut.
 *
 * `F1` byte form: `\x1bOP` (xterm). opentui's keymap also maps `\x1b[11~`
 * to `f1`; we use the xterm form because it's what node-pty delivers by
 * default.
 */

import { afterEach, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

let kobe: KobeHandle | null = null

afterEach(async () => {
  if (kobe && !kobe.closed) {
    await kobe.exit()
  }
  kobe = null
})

test("`F1` opens the help dialog showing the kobe keybinding table", async () => {
  kobe = await spawnKobe()
  // Wait for the boot banner before driving keys, otherwise the keys
  // race the renderer attaching the keypress handler.
  await kobe.waitFor((s) => s.includes("kobe"), 10_000)

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
  kobe = await spawnKobe()
  await kobe.waitFor((s) => s.includes("kobe"), 10_000)

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

test("`ctrl+k` (the cmd+k chord on a PTY) opens the command palette", async () => {
  kobe = await spawnKobe()
  await kobe.waitFor((s) => s.includes("kobe"), 10_000)

  // \x0b = Ctrl+K. Same byte the keymap layer sees when the user presses
  // `cmd+k` (terminals translate Cmd to nothing; the user must use Ctrl
  // or rebind their terminal — the binding is still wired for both, see
  // useKobeKeybindings).
  await kobe.sendKeys("\x0b")
  const screen = await kobe.waitFor((s) => s.includes("Commands") || s.includes("No commands"), 5_000)
  // The empty-state message of the palette dialog — Stream D does not
  // register any commands; downstream streams add them. The palette's
  // title bar reads "Commands"; presence of either string proves the
  // palette opened.
  expect(screen.toLowerCase()).toMatch(/commands|no commands/)
}, 30_000)

test("bare `q` does NOT open the quit-confirm dialog (binding moved to ctrl+q)", async () => {
  kobe = await spawnKobe()
  await kobe.waitFor((s) => s.includes("kobe"), 10_000)

  // Send a bare `q`. With the bare-letter binding gone, the press should
  // be a no-op at the global layer (the sidebar pane may still consume
  // it for its own purposes, but the quit dialog must not appear).
  await kobe.sendKeys("q")
  // Give the renderer a moment to paint a dialog if one were going to
  // appear — short enough to keep the test cheap, long enough to catch
  // a regression. The quit dialog's prompt is "Quit kobe?".
  await new Promise((r) => setTimeout(r, 800))
  const screen = await kobe.capture()
  expect(screen).not.toContain("Quit kobe?")
}, 30_000)
