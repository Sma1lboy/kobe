import { expect, test } from "@playwright/test"
import { VISUAL_RUN_ID } from "./visual-fixture.ts"

const TITLE = "Improve Kanban card hierarchy"
const BODY = "Make status, project, and next action easy to scan."

test("Kanban new issue intake renders in the real OpenTUI", async ({ page }) => {
  test.skip(process.env.KOBE_VISUAL !== "1", "visual ground-truth only")

  await page.goto(`/harness?run=${VISUAL_RUN_ID}`)
  const harness = page.getByTestId("opentui-harness")
  const terminal = page.getByTestId("opentui-terminal")
  const buffer = page.getByTestId("opentui-buffer")

  await expect(harness).toHaveAttribute("data-pty-status", "open", { timeout: 45_000 })
  await expect(buffer).toContainText("PROJECTS", { timeout: 45_000 })
  await expect(buffer).toContainText("TASKS")
  await expect(buffer).toContainText("Visual Fixture")

  await terminal.click({ position: { x: 24, y: 24 } })
  await page.keyboard.press("Control+H")
  await page.keyboard.press("c")

  await expect(buffer).toContainText("Kanban")
  await expect(buffer).toContainText("Backlog fixture")
  await expect(buffer).toContainText("In progress fixture")
  await expect(buffer).toContainText("Done fixture")

  await page.keyboard.press("n")
  await expect(buffer).toContainText("NEW STORY")
  await expect(buffer).toContainText("TITLE")
  await expect(buffer).toContainText("DESCRIPTION")

  await page.keyboard.type(TITLE)
  await page.keyboard.press("Enter")
  await page.keyboard.type(BODY)
  await expect(buffer).toContainText(TITLE)
  await expect(buffer).toContainText(BODY)

  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  await expect(page).toHaveScreenshot("kanban-new-issue.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
  })
})
