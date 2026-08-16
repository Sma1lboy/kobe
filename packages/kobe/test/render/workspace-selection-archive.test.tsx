/** @jsxImportSource @opentui/react */
/**
 * Regression pin for issue #34 (archive full-screen flash): archiving the
 * SELECTED task must move the local selection off it in the same snapshot
 * tick. Selection lingering on the archived task kept its TerminalTabs
 * mounted while the PTY sweep killed its sessions — the mounted Terminal
 * answered with a dead-on-attach resume, respawning the very engine
 * archiving stops, as a full center-pane repaint (the "flash") and a
 * resurrected background session.
 */

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { useState } from "react"
import type { RemoteOrchestrator } from "../../src/client/remote-orchestrator"
import { createStateCell } from "../../src/lib/external-store"
import { useWorkspaceSelection } from "../../src/tui-react/workspace/use-workspace-selection"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { act, renderComponent, settle } from "./harness"

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repos/kobe",
    branch: `feat/${id}`,
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "in_progress",
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  }
}

function mockOrchestrator(activeCell: ReturnType<typeof createStateCell<string | null>>) {
  return {
    activeTaskSignal: () => activeCell,
    setActiveTask: (id: string) => {
      activeCell.set(id)
      return Promise.resolve()
    },
    ensureWorktree: () => Promise.resolve(),
    reportUiEvent: () => {},
  } as unknown as RemoteOrchestrator
}

const KV = { store: {}, set: () => {} }

function Probe(props: {
  orch: RemoteOrchestrator
  initialTasks: readonly Task[]
  activeTaskId: string | null
  onReady: (selectedId: string | null, setTasks: (tasks: readonly Task[]) => void) => void
}) {
  const [tasks, setTasks] = useState<readonly Task[]>(props.initialTasks)
  const selection = useWorkspaceSelection({
    orch: props.orch,
    tasks,
    activeTaskId: props.activeTaskId,
    focusWorkspace: () => {},
    kv: KV,
  })
  props.onReady(selection.selectedId, setTasks)
  return null
}

describe("selection when the selected task is archived", () => {
  it("moves off the archived task instead of keeping its terminal mounted", async () => {
    process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-archive-sel-"))
    const activeCell = createStateCell<string | null>("bravo")
    const orch = mockOrchestrator(activeCell)
    let selectedId = null as string | null
    let setTasks: ((tasks: readonly Task[]) => void) | null = null
    await renderComponent(
      <Probe
        orch={orch}
        initialTasks={[task("alpha"), task("bravo")]}
        activeTaskId="bravo"
        onReady={(sel, set) => {
          selectedId = sel
          setTasks = set
        }}
      />,
      { width: 46, height: 10 },
    )
    await settle()
    expect(selectedId).toBe("bravo")

    // The daemon snapshot flips bravo archived (the TUI archive flow, or an
    // external `rove api archive`). Same array otherwise — the row is simply
    // no longer selectable.
    act(() => setTasks?.([task("alpha"), task("bravo", { archived: true })]))
    await settle()
    expect(selectedId).toBe("alpha")
  })
})
