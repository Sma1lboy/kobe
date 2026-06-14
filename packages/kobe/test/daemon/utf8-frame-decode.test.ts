import { mkdtempSync, rmSync } from "node:fs"
import { type Server, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * Regression for the UTF-8 chunk-boundary corruption: a multibyte codepoint
 * (CJK / em-dash / emoji) split across two TCP chunks must survive decode. A
 * bare `chunk.toString("utf8")` per chunk emits U+FFFD for the split halves,
 * silently mangling task titles / field notes / prompts as they stream from
 * the daemon to a front-end. Both socket read paths now feed a `StringDecoder`
 * that holds the partial sequence across chunks.
 *
 * This drives the real `KobeDaemonClient` read path against a fake raw server
 * that controls the chunk boundary — the only way to deterministically bisect
 * a multibyte character mid-frame. Corruption is detectable here because the
 * decoded title is asserted byte-for-byte (a mangled title contains U+FFFD and
 * fails the equality), unlike a structural round-trip where U+FFFD inside a
 * JSON string would still parse cleanly.
 */

// Packs a 3-byte CJK run, a 3-byte em-dash, and a 4-byte emoji, so the split
// can land inside any of the three multibyte widths.
const TRICKY = "任务 — 中文标题 🚀"

function splitMidCodepoint(line: string): [Buffer, Buffer] {
  const full = Buffer.from(`${line}\n`, "utf8")
  // Cut at a UTF-8 continuation byte (0b10xxxxxx) so the split is guaranteed
  // to bisect a multibyte character.
  let cut = -1
  for (let i = 1; i < full.length; i++) {
    if ((full[i] & 0b1100_0000) === 0b1000_0000) {
      cut = i
      break
    }
  }
  if (cut === -1) throw new Error("test string had no multibyte character")
  return [full.subarray(0, cut), full.subarray(cut)]
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return predicate()
}

describe("UTF-8 frame decode survives chunk boundaries (daemon → client)", () => {
  let raw: Server | null
  let socketPath: string
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-utf8-"))
    socketPath = join(dir, "raw.sock")
    raw = null
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => (raw ? raw.close(() => resolve()) : resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  it("reassembles an event frame whose multibyte char is split across writes", async () => {
    const eventLine = JSON.stringify({
      type: "event",
      name: "task.snapshot",
      payload: { tasks: [{ id: "t1", title: TRICKY }] },
    })
    const [head, tail] = splitMidCodepoint(eventLine)

    raw = createServer((socket) => {
      // Answer any request line (hello/subscribe) so the client's promises
      // resolve, then push the split event.
      let buf = ""
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8")
        let nl = buf.indexOf("\n")
        while (nl !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          try {
            const frame = JSON.parse(line) as { type?: string; id?: string }
            if (frame.type === "request" && frame.id) {
              socket.write(`${JSON.stringify({ type: "response", id: frame.id, payload: {} })}\n`)
            }
          } catch {
            // ignore non-JSON
          }
          nl = buf.indexOf("\n")
        }
      })
      // Push the split frame after the handshake settles.
      setTimeout(() => {
        socket.write(head)
        setTimeout(() => socket.write(tail), 15)
      }, 30)
    })
    await new Promise<void>((resolve) => raw?.listen(socketPath, () => resolve()))

    const client = new KobeDaemonClient(socketPath)
    const received: string[] = []
    client.onChannel("task.snapshot", (payload) => {
      const tasks = (payload as { tasks?: Array<{ title?: string }> }).tasks ?? []
      for (const t of tasks) if (t.title) received.push(t.title)
    })
    await client.connect()

    const ok = await until(() => received.length > 0, 1000)
    client.close()
    expect(ok).toBe(true)
    expect(received[0]).toBe(TRICKY)
    expect(received[0]).not.toContain("�")
  })
})
