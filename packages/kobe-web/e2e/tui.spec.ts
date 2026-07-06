import { expect, test } from "@playwright/test"

test("mock live-history pane renders + responds to keys in the web terminal", async ({ page }) => {
  test.skip(!!process.env.KOBE_PTY_DEV_COMMAND?.includes("sandbox"), "dev:mock only")

  await page.goto("/harness")

  const rows = page.locator(".xterm-rows")
  await expect(rows).toBeVisible()

  await expect(rows).toContainText("LIVE")
  await expect(rows).toContainText("ASSISTANT")
  await expect(rows).toContainText("预览")

  await page.locator(".xterm-helper-textarea").focus()
  await page.keyboard.press("BracketLeft")
  await page.keyboard.press("j")
  await expect(rows).toContainText("LIVE")
})
