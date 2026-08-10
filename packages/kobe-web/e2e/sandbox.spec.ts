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

/** Prefix-sequence chord: the PureTUI first stroke (`ctrl+a`), then the key. */
async function pressPrefixed(terminal: Locator, key: string): Promise<void> {
  await pressTerminal(terminal, "Control+a")
  await pressTerminal(terminal, key)
}

/**
 * Re-anchor keyboard scope on the sidebar by clicking its EMPTY lower area.
 * Not (24, 24): in the tree sidebar that pixel is the project header row,
 * and clicking a header toggles its collapse — which hid every task row and
 * made "Visual Fixture" assertions time out.
 */
async function clickSidebar(terminal: Locator): Promise<void> {
  await terminal.click({ position: { x: 24, y: 400 } })
}

/**
 * Point the content pane at the Kanban (`prefix+1`, rail row 1).
 *
 * Waits on a CARD, never on the word "Kanban": the sidebar rail prints that
 * label permanently, so asserting it passes whether or not the board opened.
 * That false positive is what let the chord move from `prefix+c` to `prefix+1`
 * with these tests still "checking" the board.
 */
async function openKanban(terminal: Locator, buffer: Locator): Promise<void> {
  await pressPrefixed(terminal, "1")
  await expect(buffer).toContainText("Backlog fixture")
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
    // The tree sidebar (default since the worktree tree landed) has no
    // PROJECTS/TASKS section headers — ready means the project row and the
    // fixture task's worktree row are both up.
    await expect(buffer).toContainText("fixture-repo", { timeout: 45_000 })
    await expect(buffer).toContainText("Visual Fixture")
    await expect(buffer).not.toContainText("PROJECTS")
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
    await clickSidebar(terminal)
    await pressTerminal(terminal, "F1")
    await expect(buffer).toContainText("keybindings")
    await expect(buffer).toContainText("ONE PRESS")
    await pressTerminal(terminal, "Escape")
    await expect(buffer).not.toContainText("keybindings")

    // Re-anchor the sidebar scope after the modal closes before sending its
    // local shortcut. Avoid Ctrl+Q here: browser PTYs may reserve the
    // flow-control character before it reaches OpenTUI.
    await clickSidebar(terminal)
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
    await clickSidebar(terminal)
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
    await clickSidebar(terminal)
    await openKanban(terminal, buffer)

    // Kanban opens focused on the fixture task's linked card; move to the
    // independent Backlog card before opening its editable detail drawer.
    await pressTerminal(terminal, "ArrowLeft")
    await pressTerminal(terminal, "Enter")
    await expect(buffer).toContainText("#1")
    await expect(buffer).toContainText("Waiting to start.")
    await expect(buffer).toContainText("WORKSPACE")

    await pressTerminal(terminal, "Escape")
    await expect(buffer).toContainText("Backlog fixture")
    await pressTerminal(terminal, "Escape")
    await expect(buffer).toContainText("Visual Fixture")
  })
})

test("Kanban new issue intake renders in the real OpenTUI", async ({ page }) => {
  test.skip(process.env.KOBE_VISUAL !== "1", "visual ground-truth only")

  await withVisualTui(page, async (terminal, buffer) => {
    await clickSidebar(terminal)
    await openKanban(terminal, buffer)

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

// LAST on purpose: pressing the sidebar's own keys below persists the pane
// hint's "used" flag into the shared fixture HOME, so any journey after this
// one would see the extinguished state instead of the fresh-HOME hints.
test("keyboard hints render and extinguish in the real OpenTUI", async ({ page }) => {
  test.skip(process.env.KOBE_VISUAL !== "1", "visual ground-truth only")

  await withVisualTui(page, async (terminal, buffer) => {
    // Fresh HOME: the status-bar micro-hint and the sidebar's first-use
    // hint are both up, resolved from the live keymap.
    await expect(buffer).toContainText("F1 help")
    await expect(buffer).toContainText("commands")
    await expect(buffer).toContainText("j/k move")

    // Using the sidebar's own keys extinguishes the pane hint…
    await clickSidebar(terminal)
    await pressTerminal(terminal, "j")
    await expect(buffer).not.toContainText("j/k move")

    // …while the status-bar hint is permanent, ⚙ button included.
    await expect(buffer).toContainText("F1 help")
    await expect(buffer).toContainText("⚙ settings")

    // NOT asserted here: the terminal-passthrough variant (`⌃Q sidebar`).
    // The fixture task has no started engine session, so the workspace
    // never mounts a live PTY passthrough surface in this journey (and CI
    // has no engine binary at all). Both hint variants and the flip are
    // pinned by test/render/keyboard-hints.test.tsx against the real
    // binding stack.
  })
})
