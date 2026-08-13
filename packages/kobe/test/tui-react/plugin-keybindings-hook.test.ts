import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  invocation: vi.fn(),
  pluginBindings: vi.fn(),
  spawn: vi.fn(),
  useBindings: vi.fn(),
}))

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }))
vi.mock("../../src/cli/invocation", () => ({ kobeCliInvocation: mocks.invocation }))
vi.mock("../../src/tui/context/keybindings-user", () => ({ pluginKeybindings: mocks.pluginBindings }))
vi.mock("../../src/tui-react/lib/keymap", () => ({ useBindings: mocks.useBindings }))

import { usePluginKeybindings } from "../../src/tui-react/workspace/use-plugin-keybindings.ts"

interface BindingSpec {
  enabled: boolean
  bindings: Array<{ key: string; cmd(): void }>
}

let spec: BindingSpec
let errorHandler: ((err: Error) => void) | undefined
let unref: ReturnType<typeof vi.fn>

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.invocation.mockReturnValue(["rove"])
  mocks.pluginBindings.mockReturnValue([
    { chord: "ctrl+a p", kind: "pane", target: "demo.panel" },
    { chord: "ctrl+a x", kind: "action", target: "demo.run" },
  ])
  mocks.useBindings.mockImplementation((factory: () => BindingSpec) => {
    spec = factory()
  })
  unref = vi.fn()
  const child = {
    on: vi.fn((_event: string, handler: (err: Error) => void) => {
      errorHandler = handler
      return child
    }),
    unref,
  }
  mocks.spawn.mockReturnValue(child)
})

describe("usePluginKeybindings", () => {
  it("maps pane and action chords to detached compatibility CLI calls", () => {
    usePluginKeybindings(true)
    expect(spec.enabled).toBe(true)
    expect(spec.bindings.map((binding) => binding.key)).toEqual(["ctrl+a p", "ctrl+a x"])

    spec.bindings[0]?.cmd()
    expect(mocks.spawn).toHaveBeenLastCalledWith("rove", ["plugin", "pane", "open", "demo.panel"], {
      detached: true,
      stdio: "ignore",
    })
    expect(unref).toHaveBeenCalledTimes(1)

    spec.bindings[1]?.cmd()
    expect(mocks.spawn).toHaveBeenLastCalledWith("rove", ["plugin", "action", "invoke", "demo.run"], {
      detached: true,
      stdio: "ignore",
    })
  })

  it("reports asynchronous and synchronous spawn failures", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    usePluginKeybindings(false)
    spec.bindings[0]?.cmd()
    errorHandler?.(new Error("async boom"))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("demo.panel: Error: async boom"))

    mocks.spawn.mockImplementation(() => {
      throw new Error("sync boom")
    })
    spec.bindings[1]?.cmd()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("demo.run: Error: sync boom"))
    warn.mockRestore()
  })
})
