import { afterEach, describe, expect, it } from "vitest"
import { hostRenderOptions, installPaneExitBackstop } from "../../src/tui/lib/host-render-options"

describe("hostRenderOptions", () => {
  it("returns the shared option set verbatim", () => {
    expect(hostRenderOptions()).toEqual({
      backgroundColor: "transparent",
      externalOutputMode: "passthrough",
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
      useKittyKeyboard: {},
    })
  })

  it("spreads onDestroy in only when present (same shape otherwise)", () => {
    const onDestroy = () => {}
    expect(hostRenderOptions(onDestroy)).toMatchObject({ onDestroy })
    expect("onDestroy" in hostRenderOptions()).toBe(false)
  })
})

describe("installPaneExitBackstop", () => {
  const SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT"] as const
  const added: Array<{ signal: (typeof SIGNALS)[number]; fn: NodeJS.SignalsListener }> = []

  afterEach(() => {
    for (const { signal, fn } of added.splice(0)) process.removeListener(signal, fn)
  })

  it("registers one delayed-exit listener per teardown signal", () => {
    const before = new Map(SIGNALS.map((s) => [s, process.listeners(s).length]))
    installPaneExitBackstop()
    for (const signal of SIGNALS) {
      const listeners = process.listeners(signal)
      expect(listeners.length).toBe((before.get(signal) ?? 0) + 1)
      added.push({ signal, fn: listeners.at(-1) as NodeJS.SignalsListener })
    }
  })
})
