import { ClientWriter } from "@sma1lboy/kobe-daemon/daemon/client-writer"
import { describe, expect, it } from "vitest"

class FakeSocket {
  writes: string[] = []
  accept = true
  private drainListeners: Array<() => void> = []

  write(data: string): boolean {
    this.writes.push(data)
    return this.accept
  }

  once(event: "drain", listener: () => void): void {
    if (event === "drain") this.drainListeners.push(listener)
  }

  emitDrain(): void {
    const listeners = this.drainListeners
    this.drainListeners = []
    for (const listener of listeners) listener()
  }
}

describe("ClientWriter backpressure", () => {
  it("pauses when write() returns false and resumes (in order) on drain", () => {
    const sock = new FakeSocket()
    const writer = new ClientWriter(sock)

    sock.accept = false
    writer.write("a\n", false)
    expect(sock.writes).toEqual(["a\n"])
    expect(writer.isPaused).toBe(true)

    writer.write("b\n", false)
    writer.write("c\n", false)
    expect(sock.writes).toEqual(["a\n"])
    expect(writer.pendingCount).toBe(2)

    sock.accept = true
    sock.emitDrain()
    expect(sock.writes).toEqual(["a\n", "b\n", "c\n"])
    expect(writer.isPaused).toBe(false)
    expect(writer.pendingCount).toBe(0)
  })

  it("drops the oldest droppable frames past the high-water mark but never a critical frame", () => {
    const sock = new FakeSocket()
    const writer = new ClientWriter(sock, { highWaterMark: 12 })

    sock.accept = false
    writer.write("PAUSE", false)
    expect(writer.isPaused).toBe(true)

    writer.write("old01", false)
    writer.write("STOP!", true)
    writer.write("new02", false)
    expect(writer.dropped).toBe(1)
    expect(writer.pendingCount).toBe(2)

    sock.accept = true
    sock.emitDrain()

    expect(sock.writes).toEqual(["PAUSE", "STOP!", "new02"])
    expect(sock.writes).toContain("STOP!")
    expect(sock.writes).not.toContain("old01")
  })

  it("never drops a critical frame even when every queued frame would overflow", () => {
    const sock = new FakeSocket()
    const writer = new ClientWriter(sock, { highWaterMark: 4 })

    sock.accept = false
    writer.write("PAUSE", false)

    writer.write("L1!!!", true)
    writer.write("L2!!!", true)
    writer.write("L3!!!", true)
    expect(writer.dropped).toBe(0)
    expect(writer.pendingCount).toBe(3)

    sock.accept = true
    sock.emitDrain()
    expect(sock.writes).toEqual(["PAUSE", "L1!!!", "L2!!!", "L3!!!"])
  })

  it("re-pauses mid-flush if the socket saturates again, losing nothing", () => {
    const sock = new FakeSocket()
    const writer = new ClientWriter(sock)

    sock.accept = false
    writer.write("a\n", false)
    writer.write("b\n", false)
    writer.write("c\n", false)

    let served = 0
    const realWrite = sock.write.bind(sock)
    sock.write = (data: string): boolean => {
      realWrite(data)
      served++
      return served < 1
    }
    sock.emitDrain()
    expect(sock.writes).toEqual(["a\n", "b\n"])
    expect(writer.isPaused).toBe(true)
    expect(writer.pendingCount).toBe(1)

    sock.write = realWrite
    sock.accept = true
    sock.emitDrain()
    expect(sock.writes).toEqual(["a\n", "b\n", "c\n"])
    expect(writer.isPaused).toBe(false)
  })

  it("does not crash if the socket throws on write", () => {
    const sock = new FakeSocket()
    const writer = new ClientWriter(sock)
    sock.write = () => {
      throw new Error("EPIPE: socket destroyed")
    }
    expect(() => writer.write("a\n", true)).not.toThrow()
    expect(writer.isPaused).toBe(false)
    expect(writer.pendingCount).toBe(0)
  })
})
