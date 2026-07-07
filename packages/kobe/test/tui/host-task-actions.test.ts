import { describe, expect, it, vi } from "vitest"
import { useWorkspaceTaskActions } from "../../src/tui/workspace/host-task-actions"
import type { Task } from "../../src/types/task.ts"

/**
 * `useWorkspaceTaskActions` is pure closure wiring (no Solid primitives), so
 * it runs under plain vitest. We pin the two behaviors that live HERE rather
 * than in the shared `lib/task-actions` flows: pin TOGGLES the current flag,
 * and move forwards its delta — plus each failure surfacing a toast instead
 * of throwing. The flow-backed actions (create/archive/…) are covered by
 * lib/task-actions' own tests.
 */
function deps(tasks: Task[], overrides: Partial<Parameters<typeof useWorkspaceTaskActions>[0]> = {}) {
  const orchestrator = {
    setPinned: vi.fn(async () => {}),
    moveTask: vi.fn(async () => {}),
  }
  const notifyError = vi.fn()
  const base = {
    orchestrator: orchestrator as never,
    tasks: () => tasks,
    dialog: {} as never,
    notifyError,
    notifyInfo: vi.fn(),
    selectedId: () => null,
    setSelectedId: vi.fn(),
    selectedTask: () => undefined,
    activateTask: async () => {},
  }
  return { orchestrator, notifyError, actions: useWorkspaceTaskActions({ ...base, ...overrides }) }
}

const task = (id: string, pinned = false): Task => ({ id, pinned }) as Task

describe("useWorkspaceTaskActions", () => {
  it("exposes every host action callback", () => {
    const { actions } = deps([])
    for (const key of [
      "createTask",
      "archiveTask",
      "deleteTask",
      "renameTask",
      "renameBranch",
      "cycleVendor",
      "togglePin",
      "moveTask",
    ]) {
      expect(typeof (actions as Record<string, unknown>)[key]).toBe("function")
    }
  })

  it("togglePin flips the current pinned flag; unknown id is a no-op", async () => {
    const { orchestrator, actions } = deps([task("t1", false), task("t2", true)])
    await actions.togglePin("t1")
    expect(orchestrator.setPinned).toHaveBeenCalledWith("t1", true)
    await actions.togglePin("t2")
    expect(orchestrator.setPinned).toHaveBeenCalledWith("t2", false)
    await actions.togglePin("nope")
    expect(orchestrator.setPinned).toHaveBeenCalledTimes(2)
  })

  it("moveTask forwards its delta and surfaces failures as a toast (never throws)", async () => {
    const { orchestrator, notifyError, actions } = deps([task("t1")])
    await actions.moveTask("t1", -1)
    expect(orchestrator.moveTask).toHaveBeenCalledWith("t1", -1)
    orchestrator.moveTask.mockRejectedValueOnce(new Error("boom"))
    await expect(actions.moveTask("t1", 1)).resolves.toBeUndefined()
    expect(notifyError).toHaveBeenCalledWith(expect.stringContaining("boom"))
  })
})
