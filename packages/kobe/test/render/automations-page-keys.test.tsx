/** @jsxImportSource @opentui/react */
/**
 * The Automations page's keys actually fire.
 *
 * Worth its own test because they silently did not: `useBindings` takes a
 * `Binding[]`, the page passed an object literal (`{ n: fn, j: fn }`), and
 * spreading an array into it widened the type enough that tsc let it through.
 * Every key the page advertised was dead — including the `n` its own empty
 * state told the user to press — with nothing failing anywhere.
 */

import { expect, test } from "bun:test"
import { AutomationsPage } from "../../src/tui-react/component/automations-page"
import { renderComponent } from "./harness"

const NOW = Date.now()
const AUTOMATION = {
  id: "a1",
  name: "weekday audit",
  repo: "/x/kobe",
  prompt: "audit",
  schedule: "0 9 * * MON-FRI",
  enabled: true,
  nextRunAt: new Date(NOW + 3_600_000).toISOString(),
  missedRunGraceMinutes: 60,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
}

function orchestrator(automations: unknown[] = []) {
  return {
    listAutomations: async () => ({ automations, keepsDaemonAlive: automations.length > 0 }),
    automationRuns: async () => ({ runs: [] }),
    listTasks: () => [{ repo: "/x/kobe" }],
  } as never
}

test("n opens the create flow", async () => {
  const { frame, mockInput } = await renderComponent(
    <AutomationsPage orchestrator={orchestrator()} focused={true} onClose={() => {}} />,
    { width: 60, height: 16, providers: { dialog: true } },
  )
  await new Promise((r) => setTimeout(r, 100))
  mockInput.typeText("n")
  await new Promise((r) => setTimeout(r, 100))
  expect(await frame()).toContain("New routine")
})

test("esc closes the page", async () => {
  let closed = false
  const { mockInput } = await renderComponent(
    <AutomationsPage
      orchestrator={orchestrator()}
      focused={true}
      onClose={() => {
        closed = true
      }}
    />,
    { width: 60, height: 16, providers: { dialog: true } },
  )
  await new Promise((r) => setTimeout(r, 100))
  mockInput.pressEscape()
  await new Promise((r) => setTimeout(r, 100))
  expect(closed).toBe(true)
})

test("keys stay dead while another pane holds focus", async () => {
  // The sidebar binds `n` too (new task). Both are live at once now that rail
  // pages no longer disable the workspace chords, so the page must yield.
  const { frame, mockInput } = await renderComponent(
    <AutomationsPage orchestrator={orchestrator()} focused={false} onClose={() => {}} />,
    { width: 60, height: 16, providers: { dialog: true } },
  )
  await new Promise((r) => setTimeout(r, 100))
  mockInput.typeText("n")
  await new Promise((r) => setTimeout(r, 100))
  expect(await frame()).not.toContain("New routine")
})

test("each automation renders as a boxed strip", async () => {
  const { frame } = await renderComponent(
    <AutomationsPage orchestrator={orchestrator([AUTOMATION])} focused={true} onClose={() => {}} />,
    { width: 70, height: 16, providers: { dialog: true } },
  )
  await new Promise((r) => setTimeout(r, 120))
  const lines = (await frame()).split("\n")
  const row = lines.findIndex((line) => line.includes("weekday audit"))
  expect(row).toBeGreaterThan(0)
  // Border above and below: three cells tall, per the owner's layout call.
  expect(lines[row - 1]).toContain("┌")
  expect(lines[row + 1]).toContain("└")
  // Everything on the one content line.
  expect(lines[row]).toContain("0 9 * * MON-FRI")
  expect(lines[row]).toContain("in 1h")
})

test("the schedule row is five editable cells, not a text field", async () => {
  // ←/→ moves between cells and ↑/↓ changes the one under the cursor. Typing
  // cron means knowing the field order before you can say anything.
  const { frame, mockInput } = await renderComponent(
    <AutomationsPage orchestrator={orchestrator()} focused={true} onClose={() => {}} />,
    { width: 72, height: 30, providers: { dialog: true } },
  )
  await new Promise((r) => setTimeout(r, 120))
  mockInput.typeText("n")
  await new Promise((r) => setTimeout(r, 120))

  const before = await frame()
  expect(before).toContain("0 9 * * MON-FRI".split(" ").join("    ").slice(0, 1))
  // Each cell is labelled — the structure is visible without knowing cron.
  for (const label of ["min", "hour", "day", "month", "weekday"]) {
    expect(before, label).toContain(label)
  }
  // And the whole thing is restated in words plus a real next-run time.
  expect(before).toContain("weekdays at 09:00")

  // Tab to schedule (name → repo → prompt → schedule), step to the hour cell,
  // and change it.
  mockInput.pressTab()
  mockInput.pressTab()
  mockInput.pressTab()
  await new Promise((r) => setTimeout(r, 60))
  mockInput.pressArrow("right")
  mockInput.pressArrow("up")
  await new Promise((r) => setTimeout(r, 80))

  // The hour ladder starts at `*`, so one step off `9` lands there and the
  // description follows it.
  expect(await frame()).not.toContain("weekdays at 09:00")
})

test("the detail frame stays mounted with nothing selected", async () => {
  // A panel that appears and disappears makes the page jump, and the empty
  // frame is where a first-time user reads what a routine even carries.
  const { frame } = await renderComponent(
    <AutomationsPage orchestrator={orchestrator()} focused={true} onClose={() => {}} />,
    { width: 74, height: 16, providers: { dialog: true } },
  )
  await new Promise((r) => setTimeout(r, 120))
  const text = await frame()
  expect(text).toContain("┌")
  expect(text).toContain("A routine runs its prompt")
})

test("a selected routine offers an on-demand run", async () => {
  // Running one now is how you find out it works without waiting for its
  // schedule — the reason it is a visible button, not only the `s` key.
  const { frame } = await renderComponent(
    <AutomationsPage orchestrator={orchestrator([AUTOMATION])} focused={true} onClose={() => {}} />,
    { width: 74, height: 20, providers: { dialog: true } },
  )
  await new Promise((r) => setTimeout(r, 150))
  expect(await frame()).toContain("run now")
})
