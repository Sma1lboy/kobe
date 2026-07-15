import { expect, test, type Locator, type Page } from "@playwright/test"
import { VISUAL_PTY_PORT, VISUAL_RUN_ID } from "./visual-fixture.ts"

const TITLE = "Improve Kanban card hierarchy"
const BODY = "Make status, project, and next action easy to scan."

type VisualJourney = (terminal: Locator, buffer: Locator) => Promise<void>

async function pressTerminal(terminal: Locator, key: string): Promise<void> {
  // Keep each browser key event targeted at xterm. Page-level keyboard events
  // can be consumed by the browser after a dialog changes the active element.
  await terminal.focus()
  await terminal.press(key)
}

async function waitForVisualPty(harness: Locator, buffer: Locator): Promise<void> {
  try {
    await expect(harness).toHaveAttribute("data-pty-status", "open", { timeout: 45_000 })
  } catch (error) {
    const output = (await buffer.textContent())?.trim() || "(no terminal output)"
    throw new Error(`visual PTY did not open; terminal output:\n${output}\n${error instanceof Error ? error.message : String(error)}`)
  }
}

async function withVisualTui(page: Page, run: VisualJourney): Promise<void> {
  // Warm mode needs a fresh session per run (a reused tab would resume the
  // previous TUI mid-Kanban); hermetic mode keeps the stable id.
  const runId = process.env.KOBE_VISUAL_KEEP === "1" ? `${VISUAL_RUN_ID}-${Date.now()}` : VISUAL_RUN_ID
  try {
    await page.goto(`/harness?run=${runId}`)
    const harness = page.getByTestId("opentui-harness")
    const terminal = page.getByTestId("opentui-terminal")
    const buffer = page.getByTestId("opentui-buffer")

    await waitForVisualPty(harness, buffer)
    await expect(buffer).toContainText("PROJECTS", { timeout: 45_000 })
    await expect(buffer).toContainText("TASKS")
    await expect(buffer).toContainText("Visual Fixture")
    await run(terminal, buffer)
  } finally {
    // Kill this run's TUI so warm mode never accumulates PTY children.
    await page.request
      .post(`http://127.0.0.1:${VISUAL_PTY_PORT}/pty/close`, { data: { tab: `visual-${runId}` } })
      .catch(() => {})
  }
}

test("workspace help and settings render in the real OpenTUI", async ({ page }) => {
  test.skip(process.env.KOBE_VISUAL !== "1", "visual ground-truth only")

  await withVisualTui(page, async (terminal, buffer) => {
    await terminal.click({ position: { x: 24, y: 24 } })
    await pressTerminal(terminal, "F1")
    await expect(buffer).toContainText("keybindings")
    await expect(buffer).toContainText("Global")
    await pressTerminal(terminal, "Escape")
    await expect(buffer).not.toContainText("keybindings")

    // Re-anchor the sidebar scope after the modal closes before sending its
    // local shortcut. Avoid Ctrl+Q here: browser PTYs may reserve the
    // flow-control character before it reaches OpenTUI.
    await terminal.click({ position: { x: 24, y: 24 } })
    await pressTerminal(terminal, "s")
    await expect(buffer).toContainText("Settings")
    await expect(buffer).toContainText("General")
    await expect(buffer).toContainText("Engines")
    await pressTerminal(terminal, "Escape")
    await expect(buffer).toContainText("Visual Fixture")
  })
})

test("worktree audit opens and returns through the real OpenTUI", async ({ page }) => {
  test.skip(process.env.KOBE_VISUAL !== "1", "visual ground-truth only")

  await withVisualTui(page, async (terminal, buffer) => {
    await terminal.click({ position: { x: 24, y: 24 } })
    await pressTerminal(terminal, "x")

    await expect(buffer).toContainText("Worktrees")
    await expect(buffer).toContainText("fixture-repo", { timeout: 45_000 })

    await pressTerminal(terminal, "Escape")
    await expect(buffer).toContainText("Visual Fixture")
  })
})

test("Kanban fixture detail opens and returns through the real OpenTUI", async ({ page }) => {
  test.skip(process.env.KOBE_VISUAL !== "1", "visual ground-truth only")

  await withVisualTui(page, async (terminal, buffer) => {
    await terminal.click({ position: { x: 24, y: 24 } })
    await pressTerminal(terminal, "c")
    await expect(buffer).toContainText("Backlog fixture")

    // Kanban opens focused on the fixture task's linked card; move to the
    // independent Backlog card before opening its editable detail drawer.
    await pressTerminal(terminal, "ArrowLeft")
    await pressTerminal(terminal, "Enter")
    await expect(buffer).toContainText("#1")
    await expect(buffer).toContainText("Waiting to start.")
    await expect(buffer).toContainText("WORKSPACE")

    await pressTerminal(terminal, "Escape")
    await expect(buffer).toContainText("Kanban")
    await expect(buffer).toContainText("Backlog fixture")
    await pressTerminal(terminal, "Escape")
    await expect(buffer).toContainText("Visual Fixture")
  })
})

test("Kanban new issue intake renders in the real OpenTUI", async ({ page }) => {
  test.skip(process.env.KOBE_VISUAL !== "1", "visual ground-truth only")

  await withVisualTui(page, async (terminal, buffer) => {
    await terminal.click({ position: { x: 24, y: 24 } })
    await pressTerminal(terminal, "c")

    await expect(buffer).toContainText("Kanban")
    await expect(buffer).toContainText("Backlog fixture")
    await expect(buffer).toContainText("In progress fixture")
    await expect(buffer).toContainText("Done fixture")

    await pressTerminal(terminal, "n")
    await expect(buffer).toContainText("NEW STORY")
    await expect(buffer).toContainText("TITLE")
    await expect(buffer).toContainText("DESCRIPTION")

    await page.keyboard.type(TITLE)
    await pressTerminal(terminal, "Enter")
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
})
