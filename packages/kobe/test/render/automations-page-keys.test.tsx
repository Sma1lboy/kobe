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
  expect(await frame()).toContain("New automation")
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
  expect(await frame()).not.toContain("New automation")
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
