import { buildPluginEnv } from "@sma1lboy/kobe-daemon/plugins/env"
import { describe, expect, it } from "vitest"

describe("buildPluginEnv", () => {
  it("publishes canonical Rove variables and identical Kobe aliases", () => {
    const env = buildPluginEnv({
      homeDir: "/home/test",
      socketPath: "/tmp/rove.sock",
      binPath: "/bin/rove",
      pluginId: "example.plugin",
      pluginRoot: "/plugin/root",
      extra: { KOBE_PLUGIN_EVENT: "startup" },
    })

    for (const suffix of [
      "HOME_DIR",
      "SOCKET_PATH",
      "BIN_PATH",
      "PLUGIN_ID",
      "PLUGIN_ROOT",
      "PLUGIN_CONFIG_DIR",
      "PLUGIN_STATE_DIR",
      "PLUGIN_EVENT",
    ]) {
      expect(env[`ROVE_${suffix}`]).toBe(env[`KOBE_${suffix}`])
    }
  })

  it("also aliases canonical entrypoint extras for legacy plugins", () => {
    const env = buildPluginEnv({
      socketPath: "/tmp/rove.sock",
      binPath: "rove",
      pluginId: "p",
      pluginRoot: "/p",
      extra: { ROVE_PLUGIN_ACTION_ID: "run" },
    })
    expect(env.KOBE_PLUGIN_ACTION_ID).toBe("run")
  })
})
