import { describe, expect, it } from "vitest"
import { daemonWebPortFromStatus } from "../dev-daemon.ts"

describe("dev daemon routing", () => {
  it("uses the web port reported by the daemon reached over the selected socket", () => {
    expect(
      daemonWebPortFromStatus(
        { socketPath: "/tmp/kobe-sandbox.sock", webPort: 5274 },
        "/tmp/kobe-sandbox.sock",
      ),
    ).toBe("5274")
  })

  it("rejects a status response from a different daemon identity", () => {
    expect(() =>
      daemonWebPortFromStatus(
        { socketPath: "/tmp/kobe-production.sock", webPort: 5174 },
        "/tmp/kobe-sandbox.sock",
      ),
    ).toThrow("daemon identity mismatch")
  })

  it("surfaces a daemon whose web transport failed to bind", () => {
    expect(() =>
      daemonWebPortFromStatus(
        {
          socketPath: "/tmp/kobe-sandbox.sock",
          webPort: null,
          webError: "port already in use",
        },
        "/tmp/kobe-sandbox.sock",
      ),
    ).toThrow("port already in use")
  })
})
