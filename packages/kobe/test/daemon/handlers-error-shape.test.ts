import {
  type DaemonHandlerContext,
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
  shapeDaemonError,
} from "@sma1lboy/kobe-daemon/daemon/server"
import { describe, expect, it } from "vitest"
import { fakeCtx } from "./handler-test-context.ts"

/**
 * Error-shaping wire-contract tests, moved VERBATIM out of
 * `handlers.test.ts` (file-size cap) — same pins, same wording guarantees.
 */

function dispatch(name: string, payload: unknown, ctx: DaemonHandlerContext): Promise<unknown> {
  return dispatchDaemonRequest(createDaemonHandlerRegistry(), name, payload, ctx)
}

describe("error shaping (one place decides the wire error)", () => {
  it("an unknown request keeps the legacy message", async () => {
    const { ctx } = fakeCtx()
    // e.g. a v2 client's removed `daemon.web.start` must still get this.
    await expect(dispatch("daemon.web.start", {}, ctx)).rejects.toThrow("unknown daemon request: daemon.web.start")
  })

  it("shapeDaemonError matches the historical on-the-wire shape exactly", () => {
    // Error instance → message + name ("Error" serializes onto the wire).
    expect(shapeDaemonError(new Error("boom"))).toEqual({ message: "boom", name: "Error" })
    const typed = new TypeError("bad type")
    expect(shapeDaemonError(typed)).toEqual({ message: "bad type", name: "TypeError" })
    // Non-Error throw → String() coercion, name undefined (dropped by
    // JSON.stringify, so the key never appears on the wire — pinned here).
    const shaped = shapeDaemonError("plain string")
    expect(shaped).toEqual({ message: "plain string", name: undefined })
    expect(JSON.stringify(shaped)).toBe('{"message":"plain string"}')
  })
})
