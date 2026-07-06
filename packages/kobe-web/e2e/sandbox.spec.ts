import { expect, test } from "@playwright/test"

test("full kobe TUI (dev:sandbox) renders + responds in the web xterm", async ({ page }) => {
  test.skip(!process.env.KOBE_PTY_DEV_COMMAND?.includes("sandbox"), "dev:sandbox only")

  await page.goto("/harness")
  const rows = page.locator(".xterm-rows")
  await expect(rows).toBeVisible({ timeout: 40_000 })

  await expect(rows).toContainText("KOBE", { timeout: 45_000 })
  await expect(rows).toContainText("PROJECTS")
  await expect(rows).toContainText("TASKS")
  await expect(rows).toContainText("new task")

  await page.locator(".xterm-helper-textarea").focus()
  await page.keyboard.press("BracketLeft")
  await expect(rows).toContainText("KOBE")
})
