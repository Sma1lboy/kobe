import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  confirm: vi.fn(),
  destroySafely: vi.fn(),
  hasRestartable: vi.fn(),
  removeTasks: vi.fn(),
}))

vi.mock("../../src/tui/component/settings-dialog/actions-core", () => ({
  destroyRendererSafely: mocks.destroySafely,
  hasRestartableDaemon: mocks.hasRestartable,
  removeTasksFileForReset: mocks.removeTasks,
}))

vi.mock("../../src/tui-react/ui/dialog-confirm", () => ({
  DialogConfirm: { show: mocks.confirm },
}))

import { confirmResetState, confirmRestartDaemon } from "../../src/tui-react/component/settings-dialog/actions.ts"

let exitSpy: MockInstance<typeof process.exit>
let stderrSpy: MockInstance<typeof process.stderr.write>

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.hasRestartable.mockReturnValue(true)
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(() => {
  exitSpy.mockRestore()
  stderrSpy.mockRestore()
})

describe("React settings actions", () => {
  it("confirms the canonical Rove paths before resetting state", async () => {
    mocks.confirm.mockResolvedValue(true)
    const renderer = { destroy: vi.fn() }

    await confirmResetState({} as never, { clear: mocks.clear } as never, renderer)

    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.anything(),
      "Reset UI state?",
      expect.stringContaining("~/.config/rove/state.json and ~/.rove/tasks.json"),
      "cancel",
    )
    expect(mocks.clear).toHaveBeenCalledTimes(1)
    expect(mocks.removeTasks).toHaveBeenCalledTimes(1)
    expect(mocks.destroySafely).toHaveBeenCalledWith(renderer, "reset")
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it("leaves state alone when reset is cancelled", async () => {
    mocks.confirm.mockResolvedValue(false)
    await confirmResetState({} as never, { clear: mocks.clear } as never, null)
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("restarts only a restartable daemon after confirmation", async () => {
    mocks.confirm.mockResolvedValue(true)
    const renderer = { destroy: vi.fn() }
    await confirmRestartDaemon({} as never, {} as never, renderer)
    expect(mocks.destroySafely).toHaveBeenCalledWith(renderer, "daemon restart")
    expect(exitSpy).toHaveBeenCalledWith(0)

    mocks.hasRestartable.mockReturnValue(false)
    mocks.confirm.mockClear()
    await confirmRestartDaemon({} as never, undefined, renderer)
    expect(mocks.confirm).not.toHaveBeenCalled()
  })
})
