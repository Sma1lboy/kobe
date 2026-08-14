import { describe, expect, it } from "vitest"
import { pluginContext, pluginEvent } from "../src/context.ts"

const BASE = {
  ROVE_PLUGIN_ID: "you.example",
  ROVE_PLUGIN_ROOT: "/plugins/you.example/checkout",
  ROVE_PLUGIN_CONFIG_DIR: "/plugins/you.example/config",
  ROVE_PLUGIN_STATE_DIR: "/plugins/you.example/state",
  ROVE_BIN_PATH: "/usr/local/bin/rove",
  ROVE_SOCKET_PATH: "/tmp/rove.sock",
}

describe("pluginContext", () => {
  it("parses the injected env", () => {
    const ctx = pluginContext({ ...BASE, ROVE_PLUGIN_EVENT: "startup" })
    expect(ctx.pluginId).toBe("you.example")
    expect(ctx.binPath).toBe("/usr/local/bin/rove")
    expect(ctx.event).toBe("startup")
    expect(ctx.homeDir).toBeUndefined()
  })

  it("throws off-host with the missing key named", () => {
    expect(() => pluginContext({})).toThrow(/ROVE_PLUGIN_ID/)
  })

  it("falls back to the legacy Kobe namespace", () => {
    const legacy = Object.fromEntries(
      Object.entries(BASE).map(([key, value]) => [key.replace("ROVE_", "KOBE_"), value]),
    )
    expect(pluginContext(legacy).pluginId).toBe("you.example")
  })
})

describe("pluginEvent", () => {
  it("parses the envelope and is null outside event entrypoints", () => {
    expect(pluginEvent(BASE)).toBeNull()
    const envelope = pluginEvent({
      ...BASE,
      ROVE_PLUGIN_EVENT_JSON: JSON.stringify({ event: "agent.idle", taskId: "t1", at: 123 }),
    })
    expect(envelope?.event).toBe("agent.idle")
    expect(envelope?.taskId).toBe("t1")
  })
})
