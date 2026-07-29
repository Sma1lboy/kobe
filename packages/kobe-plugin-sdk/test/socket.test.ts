import { mkdtempSync } from "node:fs"
import { type Server, type Socket, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { KobeSocket } from "../src/socket.ts"

let server: Server | null = null

function fakeDaemon(onFrame: (frame: { id: string; name: string }, sock: Socket) => void): string {
  const path = join(mkdtempSync(join(tmpdir(), "kobe-sdk-sock-")), "d.sock")
  server = createServer((sock) => {
    let buf = ""
    sock.setEncoding("utf8")
    sock.on("data", (chunk: string) => {
      buf += chunk
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) onFrame(JSON.parse(line), sock)
      }
    })
  })
  server.listen(path)
  return path
}

afterEach(() => {
  server?.close()
  server = null
})

describe("KobeSocket", () => {
  it("resolves requests with the matching response payload", async () => {
    const path = fakeDaemon((frame, sock) => {
      sock.write(`${JSON.stringify({ type: "response", id: frame.id, payload: { echo: frame.name } })}\n`)
    })
    const client = new KobeSocket()
    await client.connect({ socketPath: path })
    expect(await client.request("task.list")).toEqual({ echo: "task.list" })
    client.close()
  })

  it("rejects on daemon error frames and routes event frames to the handler", async () => {
    const path = fakeDaemon((frame, sock) => {
      if (frame.name === "boom") {
        sock.write(`${JSON.stringify({ type: "response", id: frame.id, error: { message: "nope" } })}\n`)
      } else {
        sock.write(`${JSON.stringify({ type: "response", id: frame.id, payload: {} })}\n`)
        sock.write(`${JSON.stringify({ type: "event", name: "task.snapshot", payload: { tasks: [] } })}\n`)
      }
    })
    const client = new KobeSocket()
    await client.connect({ socketPath: path })
    await expect(client.request("boom")).rejects.toThrow("nope")
    const seen: string[] = []
    await client.subscribe((name) => seen.push(name), ["task.snapshot"])
    await new Promise((r) => setTimeout(r, 30))
    expect(seen).toEqual(["task.snapshot"])
    client.close()
  })
})
