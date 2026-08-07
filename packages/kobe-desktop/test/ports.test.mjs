import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { findPorts } from "../src/ports.mjs"

describe("desktop port selection", () => {
  it("does not hand a new dev daemon an occupied production port", async () => {
    const occupied = new Set([5174])
    const ports = await findPorts(5173, 5174, async (port) => !occupied.has(port))

    assert.deepEqual(ports, { web: 5173, daemonWeb: 5176, pty: 5175 })
  })

  it("allocates three distinct ports when defaults are free", async () => {
    const ports = await findPorts(5173, 5174, async () => true)

    assert.deepEqual(ports, { web: 5173, daemonWeb: 5174, pty: 5175 })
  })

  it("keeps the PTY exactly two ports above the selected web port", async () => {
    const occupied = new Set([5175])
    const ports = await findPorts(5173, 5174, async (port) => !occupied.has(port))

    assert.equal(ports.pty, ports.web + 2)
    assert.deepEqual(ports, { web: 5174, daemonWeb: 5177, pty: 5176 })
  })
})
