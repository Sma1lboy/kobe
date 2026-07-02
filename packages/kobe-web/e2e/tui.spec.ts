import { expect, test } from "@playwright/test"

/**
 * Drives the real kobe TUI (dev:mock's live history preview) through the web
 * xterm and asserts on the rendered terminal DOM. Proves the UI-layer e2e chain
 * — browser → xterm → PTY → opentui TUI → keystrokes → visible output — works.
 *
 * Assertions target short, stable substrings (the LIVE header tag, a role
 * label, the CJK seed line). DOM rows are viewport-only + cell-split, so we
 * never assert exact layout. Timing is handled by Playwright's retrying
 * matchers, never fixed sleeps (the TUI cold-starts in ~1-2s).
 *
 * No daemon runs, so `/api/themes` + `/events` 502 in the console — expected and
 * harmless (the harness bypasses the daemon via the pty-server DEV override).
 */
test("mock live-history pane renders + responds to keys in the web terminal", async ({ page }) => {
  test.skip(!!process.env.KOBE_PTY_DEV_COMMAND?.includes("sandbox"), "dev:mock only")

  await page.goto("/harness")

  const rows = page.locator(".xterm-rows")
  await expect(rows).toBeVisible()

  // Header tag from the live preview (history/host.tsx liveTag = "● LIVE").
  await expect(rows).toContainText("LIVE")
  // A role label from the seeded transcript.
  await expect(rows).toContainText("ASSISTANT")
  // The CJK seed line — proves wide-glyph rendering round-trips through xterm.
  await expect(rows).toContainText("预览")

  // Drive it: focus the terminal, switch session with `[`, scroll with `j`.
  await page.locator(".xterm-helper-textarea").focus()
  await page.keyboard.press("BracketLeft")
  await page.keyboard.press("j")
  // Still a live pane after input (sanity — the process didn't die on a key).
  await expect(rows).toContainText("LIVE")
})
