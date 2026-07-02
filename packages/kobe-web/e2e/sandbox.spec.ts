import { expect, test } from "@playwright/test"

/**
 * Goal B — the FULL kobe TUI (dev:sandbox: real kobe + tmux + engine) driven
 * through the web xterm. Run with KOBE_PTY_DEV_COMMAND="bun run dev:sandbox".
 *
 * Proves the whole product renders + responds over the browser terminal: brand
 * header, the Tasks rail (PROJECTS / TASKS), the keys legend, and a live engine
 * pane — all inside tmux inside the PTY inside xterm. tmux sessions are cleaned
 * by the global teardown (dev:sandbox:reset) so runs don't bleed.
 */
test("full kobe TUI (dev:sandbox) renders + responds in the web xterm", async ({ page }) => {
  test.skip(!process.env.KOBE_PTY_DEV_COMMAND?.includes("sandbox"), "dev:sandbox only")

  await page.goto("/harness")
  const rows = page.locator(".xterm-rows")
  await expect(rows).toBeVisible({ timeout: 40_000 })

  // Full kobe + tmux + engine cold start — the retrying matcher waits it out.
  await expect(rows).toContainText("KOBE", { timeout: 45_000 })
  await expect(rows).toContainText("PROJECTS")
  await expect(rows).toContainText("TASKS")
  // The Tasks-pane keys legend rendered (proves the rail, not just a bare shell).
  await expect(rows).toContainText("new task")

  // Drive it: focus the terminal and switch the sidebar view with `[`.
  await page.locator(".xterm-helper-textarea").focus()
  await page.keyboard.press("BracketLeft")
  // Still the full TUI after input (didn't die on a key).
  await expect(rows).toContainText("KOBE")
})
