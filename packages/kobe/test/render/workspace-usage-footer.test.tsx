/** @jsxImportSource @opentui/react */
/**
 * The quota footer renders from a daemon snapshot only — never fetches, and
 * never occupies a row when there is nothing to show.
 */

import { expect, test } from "bun:test"
import { createStateCell } from "../../src/lib/external-store"
import type { RemoteOrchestrator } from "../../src/tui-react/../client/remote-orchestrator"
import { WorkspaceFrame } from "../../src/tui-react/workspace/host-footer"
import type { EngineQuotaUsage } from "../../src/types/engine"
import { renderComponent } from "./harness"

/** Minimal stand-in: the footer only ever calls `usageSnapshotSignal()`. */
function orchestratorWith(usage: ReadonlyMap<string, EngineQuotaUsage> | null): RemoteOrchestrator {
  const cell = createStateCell(usage)
  return { usageSnapshotSignal: () => cell } as unknown as RemoteOrchestrator
}

const IN_AN_HOUR = Date.now() + 60 * 60 * 1000

test("renders one chip per window per vendor", async () => {
  const orch = orchestratorWith(
    new Map<string, EngineQuotaUsage>([
      [
        "claude",
        {
          capturedAt: Date.now(),
          windows: [
            { kind: "session", label: "5h", percent: 42, resetsAt: IN_AN_HOUR },
            { kind: "weekly_all", label: "7d", percent: 12, resetsAt: null },
          ],
        },
      ],
      ["codex", { capturedAt: Date.now(), windows: [{ kind: "primary", label: "7d", percent: 47, resetsAt: null }] }],
    ]),
  )
  const { frame } = await renderComponent(
    <WorkspaceFrame orchestrator={orch}>
      <box />
    </WorkspaceFrame>,
    { width: 80, height: 6 },
  )
  const out = await frame()
  expect(out).toContain("5h 42%")
  expect(out).toContain("7d 12%")
  expect(out).toContain("7d 47%")
  // The footer is the LAST line — children keep the rest of the column.
  expect(out.trimEnd().split("\n").at(-1)).toContain("5h 42%")
})

test("renders nothing when no vendor has a snapshot", async () => {
  const { frame } = await renderComponent(
    <WorkspaceFrame orchestrator={orchestratorWith(null)}>
      <text>body</text>
    </WorkspaceFrame>,
    { width: 40, height: 4 },
  )
  const out = await frame()
  expect(out).toContain("body")
  expect(out).not.toContain("%")
})
