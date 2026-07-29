import { describe, expect, it } from "vitest"
import { pluginContext, pluginEvent } from "../src/context.ts"

const BASE = {
  KOBE_PLUGIN_ID: "you.example",
  KOBE_PLUGIN_ROOT: "/plugins/you.example/checkout",
  KOBE_PLUGIN_CONFIG_DIR: "/plugins/you.example/config",
  KOBE_PLUGIN_STATE_DIR: "/plugins/you.example/state",
  KOBE_BIN_PATH: "/usr/local/bin/kobe",
  KOBE_SOCKET_PATH: "/tmp/kobe.sock",
}

describe("pluginContext", () => {
  it("parses the injected env", () => {
    const ctx = pluginContext({ ...BASE, KOBE_PLUGIN_EVENT: "startup" })
    expect(ctx.pluginId).toBe("you.example")
    expect(ctx.binPath).toBe("/usr/local/bin/kobe")
    expect(ctx.event).toBe("startup")
    expect(ctx.homeDir).toBeUndefined()
  })

  it("throws off-host with the missing key named", () => {
    expect(() => pluginContext({})).toThrow(/KOBE_PLUGIN_ID/)
  })
})

describe("pluginEvent", () => {
  it("parses the envelope and is null outside event entrypoints", () => {
    expect(pluginEvent(BASE)).toBeNull()
    const envelope = pluginEvent({
      ...BASE,
      KOBE_PLUGIN_EVENT_JSON: JSON.stringify({ event: "agent.idle", taskId: "t1", at: 123 }),
    })
    expect(envelope?.event).toBe("agent.idle")
    expect(envelope?.taskId).toBe("t1")
  })
})
