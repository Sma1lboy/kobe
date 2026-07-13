import { expect, test } from "@playwright/test"

/** Transport smoke only. Visual acceptance belongs exclusively to `bun run visual`. */
test("mock OpenTUI round-trips through the web terminal", async ({ page }) => {
  test.skip(process.env.KOBE_VISUAL === "1", "dev:mock transport only")

  await page.goto("/harness?run=mock-smoke")
  const harness = page.getByTestId("opentui-harness")
  const terminal = page.getByTestId("opentui-terminal")
  const buffer = page.getByTestId("opentui-buffer")

  await expect(harness).toHaveAttribute("data-pty-status", "open")
  await expect(buffer).toContainText("v0.0.0-mock")
  await expect(buffer).toContainText("MOCK-SCENE-OK")

  await terminal.click({ position: { x: 24, y: 24 } })
  await page.keyboard.press("BracketLeft")
  await expect(buffer).toContainText("v0.0.0-mock")
})
