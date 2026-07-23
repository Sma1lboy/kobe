import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { createDaemonHandlerRegistry, shapeDaemonError } from "@sma1lboy/kobe-daemon/daemon/server"
import { WEB_RPC_ALLOWLIST, WEB_RPC_ALLOWSET } from "@sma1lboy/kobe-daemon/daemon/web-rpc-allowlist"
import { webExposedRpcNames, webRpcErrorBody } from "@sma1lboy/kobe-daemon/daemon/web-server"
import { describe, expect, it } from "vitest"

/**
 * Web-exposure policy + error-shape parity for the unified dispatch seam.
 *
 * WHY these matter: the web transport's RPC allowlist used to be a
 * hand-maintained constant that could silently drift from the handler
 * registry, and its error envelope was hand-rolled separately from the
 * socket's shapeDaemonError. Both now derive from the registry
 * (`web: true` per entry / webExposedRpcNames) and from shapeDaemonError
 * (webRpcErrorBody). These tests pin the SECURITY contract — the exact set
 * of browser-reachable verbs, so exposing a new one is a deliberate,
 * test-visible act — and the wire parity between the two transports.
 */

/** The full browser-reachable surface, pinned EXACTLY (order-insensitive). */
const EXPOSED: readonly DaemonRequestName[] = [
  "daemon.status",
  "task.list",
  "task.get",
  "task.create",
  "task.archive",
  "task.rename",
  "task.setBranch",
  "task.setVendor",
  "task.delete",
  "task.land",
  "task.pin",
  "task.move",
  "task.status",
  "task.reorder",
  "task.ensureMain",
  "task.openDir",
  "task.ensureWorktree",
  "task.setActive",
  "worktree.discoverAdoptable",
  "worktree.adopt",
]

// Verbs that must never cross the web boundary, whatever the daemon grows:
// connection lifecycle, the kill switch, hook ingest, and bulk mutation.
const FORBIDDEN = ["hello", "subscribe", "daemon.stop", "engine.reportEvent", "worktree.reconcile"] as const

describe("registry web-exposure policy", () => {
  const exposed = webExposedRpcNames(createDaemonHandlerRegistry())

  it("exposes exactly the pinned browser-reachable surface", () => {
    expect([...exposed].sort()).toEqual([...EXPOSED].sort())
  })

  it("never exposes connection/lifecycle/hook verbs", () => {
    for (const name of FORBIDDEN) {
      expect(exposed.has(name as DaemonRequestName)).toBe(false)
    }
  })

  it("the web-rpc-allowlist shim mirrors the registry metadata exactly", () => {
    expect(new Set(WEB_RPC_ALLOWLIST)).toEqual(new Set(exposed))
    expect(WEB_RPC_ALLOWSET.size).toBe(WEB_RPC_ALLOWLIST.length)
    for (const name of exposed) expect(WEB_RPC_ALLOWSET.has(name)).toBe(true)
  })
})

describe("socket/web error-shape parity", () => {
  it("a named error carries the same message + name on both transports", () => {
    const err = new Error("illegal transition for task t1")
    err.name = "IllegalTransitionError"
    const socket = shapeDaemonError(err)
    const web = webRpcErrorBody(err)
    expect(socket).toEqual({ message: "illegal transition for task t1", name: "IllegalTransitionError" })
    // Same fields, message keyed as `error` (the SPA's api-client parses that key).
    expect(web).toEqual({ error: socket.message, name: socket.name })
  })

  it("a plain anonymous Error: same message; web drops the noise name (historical HTTP shape)", () => {
    const err = new Error("boom")
    expect(shapeDaemonError(err)).toEqual({ message: "boom", name: "Error" })
    const web = webRpcErrorBody(err)
    expect(web).toEqual({ error: "boom" })
    expect(web).not.toHaveProperty("name")
  })

  it("a non-Error throw is String()-coerced identically, with no name on either wire", () => {
    const socket = shapeDaemonError("plain string")
    const web = webRpcErrorBody("plain string")
    expect(socket.message).toBe("plain string")
    // shapeDaemonError leaves name: undefined (dropped by JSON.stringify);
    // the web body omits the key structurally.
    expect(socket.name).toBeUndefined()
    expect(web).toEqual({ error: "plain string" })
  })

  it("a subclassed error (TypeError) keeps its name on both transports", () => {
    const err = new TypeError("bad type")
    expect(shapeDaemonError(err)).toEqual({ message: "bad type", name: "TypeError" })
    expect(webRpcErrorBody(err)).toEqual({ error: "bad type", name: "TypeError" })
  })
})
