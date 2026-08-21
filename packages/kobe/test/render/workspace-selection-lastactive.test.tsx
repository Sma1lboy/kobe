/** @jsxImportSource @opentui/react */
/**
 * selectTask must publish the active task even when the id is already the
 * local selection (issue #14 follow-up): a fresh home boots with a
 * fallback-selected task but a NULL active record, and the old early-return
 * meant the first Enter never called setActiveTask — so lastActive stayed
 * unwritten and narrow mode's "↩ recent" row never appeared.
 */

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RemoteOrchestrator } from "../../src/client/remote-orchestrator"
import { createStateCell } from "../../src/lib/external-store"
import { useWorkspaceSelection } from "../../src/tui-react/workspace/use-workspace-selection"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { act, renderComponent, settle } from "./harness"

function task(id: string): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repos/rove",
    branch: `feat/${id}`,
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "in_progress",
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  }
}

/** Minimal stand-in covering what useWorkspaceSelection touches. */
function mockOrchestrator(activeCell: ReturnType<typeof createStateCell<string | null>>) {
  const published: string[] = []
  const orch = {
    activeTaskSignal: () => activeCell,
    setActiveTask: (id: string) => {
      published.push(id)
      activeCell.set(id)
      return Promise.resolve()
    },
    ensureWorktree: () => Promise.resolve(),
    reportUiEvent: () => {},
  } as unknown as RemoteOrchestrator
  return { orch, published }
}

const KV = { store: {}, set: () => {} }

function Probe(props: {
  orch: RemoteOrchestrator
  tasks: readonly Task[]
  activeTaskId: string | null
  onReady: (selectTask: (id: string) => void, selectedId: string | null) => void
}) {
  const selection = useWorkspaceSelection({
    orch: props.orch,
    tasks: props.tasks,
    activeTaskId: props.activeTaskId,
    focusWorkspace: () => {},
    kv: KV,
  })
  props.onReady(selection.selectTask, selection.selectedId)
  return null
}

describe("selectTask on a fresh home", () => {
  it("re-selecting the fallback-selected task still publishes it as active", async () => {
    process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-lastactive-"))
    const activeCell = createStateCell<string | null>(null)
    const { orch, published } = mockOrchestrator(activeCell)
    const tasks = [task("alpha"), task("bravo")]
    let selectTask: ((id: string) => void) | null = null
    let selectedId = null as string | null
    await renderComponent(
      <Probe
        orch={orch}
        tasks={tasks}
        activeTaskId={null}
        onReady={(fn, sel) => {
          selectTask = fn
          selectedId = sel
        }}
      />,
      { width: 46, height: 10 },
    )
    await settle()
    // Fresh home: the fallback effect selected the first task, but nothing
    // was PUBLISHED — the active record is still null.
    expect(selectedId).toBe("alpha")
    expect(published).toEqual([])

    // Entering that pre-selected task must publish it (the fix).
    act(() => selectTask?.("alpha"))
    await settle()
    expect(published).toEqual(["alpha"])

    // Idempotent: once the daemon agrees, re-entering does not re-publish.
    act(() => selectTask?.("alpha"))
    await settle()
    expect(published).toEqual(["alpha"])
  })
})
