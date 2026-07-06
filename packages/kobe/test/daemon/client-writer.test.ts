/**
 * Per-client socket write backpressure (fix E). The daemon is a single
 * long-lived writer fanning channel frames out to every subscribed socket;
 * `socket.write()` returning `false` (OS send buffer full for a slow client)
 * used to be ignored, so Node queued unbounded heap → the daemon could grow to
 * GBs and OOM. {@link ClientWriter} obeys backpressure per client: it pauses on
 * `false`, resumes on `'drain'`, bounds its queue (dropping the oldest
 * droppable frames), and NEVER drops a critical (lifecycle/response) frame nor
 * reorders a single client's stream.
 */

import { ClientWriter } from "@sma1lboy/kobe-daemon/daemon/client-writer"
import { describe, expect, it } from "vitest"

/**
 * Fake socket whose `write` returns `accept` (set `false` to simulate a full
 * send buffer) and that captures `'drain'` listeners so a test can fire drain
 * deterministically. Records every line handed to the wire.
 */
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

    // Socket buffer is full: the first frame is accepted by the kernel but
    // write() reports false → the writer must pause.
    sock.accept = false
    writer.write("a\n", false)
    expect(sock.writes).toEqual(["a\n"])
    expect(writer.isPaused).toBe(true)

    // While paused, further frames are buffered, NOT handed to the socket.
    writer.write("b\n", false)
    writer.write("c\n", false)
    expect(sock.writes).toEqual(["a\n"])
    expect(writer.pendingCount).toBe(2)

    // Drain → flush the queue in order, then unpause.
    sock.accept = true
    sock.emitDrain()
    expect(sock.writes).toEqual(["a\n", "b\n", "c\n"])
    expect(writer.isPaused).toBe(false)
    expect(writer.pendingCount).toBe(0)
  })

  it("drops the oldest droppable frames past the high-water mark but never a critical frame", () => {
    const sock = new FakeSocket()
    const writer = new ClientWriter(sock, { highWaterMark: 12 })

    // Saturate the socket so subsequent frames queue.
    sock.accept = false
    writer.write("PAUSE", false)
    expect(writer.isPaused).toBe(true)

    // Fill the queue past 12 bytes (each line is 5 bytes):
    //   old01 (5) → STOP! critical (10) → new02 (15 > 12) → drop oldest
    //   droppable (old01); STOP! is kept regardless.
    writer.write("old01", false)
    writer.write("STOP!", true)
    writer.write("new02", false)
    expect(writer.dropped).toBe(1)
    expect(writer.pendingCount).toBe(2)

    sock.accept = true
    sock.emitDrain()

    // The lifecycle frame survived; the dropped droppable frame did not; order
    // is preserved among survivors.
    expect(sock.writes).toEqual(["PAUSE", "STOP!", "new02"])
    expect(sock.writes).toContain("STOP!")
    expect(sock.writes).not.toContain("old01")
  })

  it("never drops a critical frame even when every queued frame would overflow", () => {
    const sock = new FakeSocket()
    const writer = new ClientWriter(sock, { highWaterMark: 4 })

    sock.accept = false
    writer.write("PAUSE", false)

    // Three criticals, each 5 bytes, all over a 4-byte mark: none may be shed.
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
    writer.write("a\n", false) // pause
    writer.write("b\n", false)
    writer.write("c\n", false)

    // First drain: socket accepts exactly one more frame then saturates again.
    let served = 0
    const realWrite = sock.write.bind(sock)
    sock.write = (data: string): boolean => {
      realWrite(data)
      served++
      return served < 1 // only the first flushed frame is accepted
    }
    sock.emitDrain()
    expect(sock.writes).toEqual(["a\n", "b\n"]) // b flushed, then re-paused
    expect(writer.isPaused).toBe(true)
    expect(writer.pendingCount).toBe(1) // c still queued

    // Second drain with a healthy socket: c finally lands.
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
    // Swallowed write is treated as accepted → no pause, no queue leak.
    expect(writer.isPaused).toBe(false)
    expect(writer.pendingCount).toBe(0)
  })
})
