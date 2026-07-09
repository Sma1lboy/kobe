/**
 * Adversarial socket paths, over the REAL Unix socket — the failure modes
 * the happy-path integration tests never send: malformed bytes, unknown
 * request names, protocol-range mismatches, and clients that vanish or
 * stall mid-conversation. Each test pins today's wire contract exactly
 * (parse-error id, error wording, bare-`{message}` vs shaped errors) so a
 * dispatch refactor that changes bytes fails loudly here.
 */

import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { DAEMON_PROTOCOL_VERSION, MIN_COMPATIBLE_PROTOCOL_VERSION } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type DaemonHarness, bootDaemonHarness, waitFor } from "./harness.ts"

describe("daemon socket adversarial paths", () => {
  let h: DaemonHarness

  beforeEach(async () => {
    h = await bootDaemonHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  it("a malformed JSON line gets a parse-error response and the connection survives", async () => {
    const raw = await h.rawSocket()
    raw.sendLine("this is not json {{{")
    const parseError = await raw.nextFrame((f) => f.type === "response" && f.id === "parse-error")
    expect(parseError.error?.message).toBeTruthy()
    // The parse-error path deliberately sends a bare `{ message }` — no
    // `name` key ever hits the wire on this branch (server.ts).
    expect(parseError.error && "name" in parseError.error).toBe(false)

    // The connection is still usable: a well-formed request round-trips.
    raw.request("daemon.status", {}, "after-garbage")
    const ok = await raw.nextFrame((f) => f.type === "response" && f.id === "after-garbage")
    expect(ok.error).toBeUndefined()
    expect((ok.payload as { daemonPid: number }).daemonPid).toBe(process.pid)
  })

  it("a non-request frame from a client is refused with the request-only wire error", async () => {
    const raw = await h.rawSocket()
    raw.sendLine(JSON.stringify({ type: "event", name: "task.snapshot", payload: {} }))
    const refusal = await raw.nextFrame((f) => f.type === "response" && f.id === "parse-error")
    expect(refusal.error?.message).toBe("daemon only accepts request frames from clients")
  })

  it("an unknown request name rejects with the registry error and keeps the client usable", async () => {
    const client = h.client()
    await expect(client.request("definitely.not.a.thing" as DaemonRequestName)).rejects.toThrow(
      "unknown daemon request: definitely.not.a.thing",
    )
    // The error is per-request, not per-connection: the same client still works.
    const status = (await client.request("daemon.status")) as { daemonPid: number }
    expect(status.daemonPid).toBe(process.pid)
  })

  it("hello refuses an out-of-range protocol peer and accepts a compatible one", async () => {
    const client = h.client()
    // An ancient client below the daemon's minimum → clear upgrade error.
    const ancient = MIN_COMPATIBLE_PROTOCOL_VERSION - 1
    await expect(client.request("hello", { protocolVersion: ancient, minProtocolVersion: ancient })).rejects.toThrow(
      /Upgrade your kobe/,
    )
    // A future client whose MINIMUM is above the daemon's version → also refused.
    const future = DAEMON_PROTOCOL_VERSION + 50
    await expect(client.request("hello", { protocolVersion: future, minProtocolVersion: future })).rejects.toThrow(
      /Upgrade your kobe/,
    )
    // The mismatch is per-request: the same connection completes a compatible
    // handshake afterwards, and the daemon advertises its own range.
    const hello = (await client.request("hello", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      minProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
    })) as { protocolVersion: number; minProtocolVersion: number }
    expect(hello.protocolVersion).toBe(DAEMON_PROTOCOL_VERSION)
    expect(hello.minProtocolVersion).toBe(MIN_COMPATIBLE_PROTOCOL_VERSION)
  })

  it("a client that disconnects mid-request never takes the daemon down", async () => {
    // Fire a request and hard-destroy the socket before the response can be
    // written — the daemon's reply hits a dead socket (EPIPE path).
    const raw = await h.rawSocket()
    raw.request("hello", {})
    raw.destroy()

    // Do it again with a subscriber, so the teardown also races channel replay.
    const raw2 = await h.rawSocket()
    raw2.request("subscribe", {})
    raw2.destroy()

    // The daemon must still be fully alive for a fresh client.
    const client = h.client()
    const status = (await client.request("daemon.status")) as { daemonPid: number }
    expect(status.daemonPid).toBe(process.pid)
  })

  it("a stalled subscriber never blocks delivery to a healthy one (backpressure end-to-end)", async () => {
    // A subscriber that stops reading: its kernel buffer fills, pushing the
    // daemon's writes for this socket into the bounded ClientWriter queue
    // (droppable event frames shed past the high-water mark) instead of
    // stalling the broadcast loop or growing the daemon heap unbounded.
    const stalled = await h.rawSocket()
    stalled.request("subscribe", {})
    await stalled.nextFrame((f) => f.type === "response")
    stalled.socket.pause() // stop reading — never resumes

    const seen: string[] = []
    const healthy = h.client()
    healthy.onChannel("engine-state", (payload) => seen.push(payload.taskId))
    await healthy.subscribe()

    // Publish a meaty event stream: 100 distinct tasks × an ~8KB note each
    // (~800KB of fan-out — far past a Unix socket's buffer for the stalled
    // reader). Every publish must still reach the healthy subscriber.
    const note = "x".repeat(8192)
    const reporter = h.client()
    for (let i = 0; i < 100; i++) {
      await reporter.request("engine.reportEvent", { taskId: `task-${i}`, kind: "turn-start", detail: { note } })
    }

    expect(await waitFor(() => seen.includes("task-99"), 5000)).toBe(true)
    expect(seen.length).toBe(100)
    // And the daemon still answers RPC promptly with the stalled socket open.
    const status = (await healthy.request("daemon.status")) as { daemonPid: number }
    expect(status.daemonPid).toBe(process.pid)
  })
})
