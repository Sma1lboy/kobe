import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLocalSandbox } from "../../src/engine/ai-sdk/local-sandbox"

type Session = Awaited<ReturnType<ReturnType<typeof createLocalSandbox>["createSession"]>>

async function* bytesOf(s: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(s)
}

describe("createLocalSandbox (real temp dir)", () => {
  let root: string
  let session: Session

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kobe-sandbox-"))
    session = await createLocalSandbox({ workRoot: root }).createSession({})
  })
  afterEach(async () => {
    await session.destroy?.()
    rmSync(root, { recursive: true, force: true })
  })

  it("round-trips text via writeTextFile/readTextFile", async () => {
    const p = join(root, "a.txt")
    await session.writeTextFile({ path: p, content: "line1\nline2\nline3" })
    expect(await session.readTextFile({ path: p })).toBe("line1\nline2\nline3")
    expect(await session.readTextFile({ path: p, startLine: 2, endLine: 3 })).toBe("line2\nline3")
  })

  it("round-trips bytes via writeBinaryFile/readBinaryFile", async () => {
    const p = join(root, "b.bin")
    const data = new Uint8Array([1, 2, 3, 4])
    await session.writeBinaryFile({ path: p, content: data })
    expect(await session.readBinaryFile({ path: p })).toEqual(data)
  })

  it("streams bytes via writeFile/readFile", async () => {
    const p = join(root, "c.dat")
    await session.writeFile({ path: p, content: bytesOf("streamed") as never })
    const stream = await session.readFile({ path: p })
    expect(stream).not.toBeNull()
    expect(await new Response(stream as ReadableStream<Uint8Array>).text()).toBe("streamed")
  })

  it("creates parent directories on write", async () => {
    const p = join(root, "nested", "deep", "d.txt")
    await session.writeTextFile({ path: p, content: "ok" })
    expect(await session.readTextFile({ path: p })).toBe("ok")
  })

  it("returns null for a missing file (ENOENT) on every read shape", async () => {
    const missing = join(root, "nope.txt")
    expect(await session.readTextFile({ path: missing })).toBeNull()
    expect(await session.readBinaryFile({ path: missing })).toBeNull()
    expect(await session.readFile({ path: missing })).toBeNull()
  })

  it("propagates non-ENOENT read errors (EISDIR) instead of collapsing to null", async () => {
    const dir = join(root, "adir")
    mkdirSync(dir)
    await expect(session.readTextFile({ path: dir })).rejects.toThrow()
    await expect(session.readBinaryFile({ path: dir })).rejects.toThrow()
    await expect(session.readFile({ path: dir })).rejects.toThrow()
  })

  it("runs a command and captures stdout/exit code", async () => {
    const res = await session.run({ command: "echo hello" })
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain("hello")
  })

  it("spawns a process and waits for exit", async () => {
    const proc = await session.spawn({ command: "exit 3" })
    expect((await proc.wait()).exitCode).toBe(3)
  })

  it("exposes a port and resolves its URL", async () => {
    expect(session.ports.length).toBeGreaterThan(0)
    await session.setPorts?.([4321])
    expect(session.ports).toContain(4321)
    expect(await session.getPortUrl({ port: 4321 })).toBe("http://127.0.0.1:4321")
  })

  it("restricted() returns a filesystem/exec view", () => {
    expect(typeof session.restricted().run).toBe("function")
  })

  it("reattaches to the same local workRoot by session id", async () => {
    const provider = createLocalSandbox({ workRoot: root })
    const first = await provider.createSession({ sessionId: "stable-session" })
    const p = join(root, "persisted.txt")
    await first.writeTextFile({ path: p, content: "kept" })
    await first.stop()

    expect(provider.resumeSession).toBeDefined()
    const resumed = await provider.resumeSession?.({ sessionId: "stable-session" })

    expect(resumed?.id).toBe("stable-session")
    expect(await resumed?.readTextFile({ path: p })).toBe("kept")
    await resumed?.destroy?.()
  })
})
