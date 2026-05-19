import { describe, expect, it } from "vitest"
import { type RpcClient, RpcError, parseRpcArgs, routeVerb, runRpc } from "../../src/cli/rpc.ts"
import type { DaemonRequestName } from "../../src/daemon/protocol.ts"

interface RecordedCall {
  readonly name: DaemonRequestName
  readonly payload: unknown
}

interface FakeOptions {
  connectThrows?: Error
  requestThrows?: Error
  responsePayload?: unknown
}

function createFakeClient(opts: FakeOptions = {}): {
  client: RpcClient
  calls: RecordedCall[]
  connected: { value: boolean }
  closed: { value: boolean }
} {
  const calls: RecordedCall[] = []
  const connected = { value: false }
  const closed = { value: false }
  const client: RpcClient = {
    async connect() {
      if (opts.connectThrows) throw opts.connectThrows
      connected.value = true
    },
    async request(name, payload) {
      calls.push({ name, payload })
      if (opts.requestThrows) throw opts.requestThrows
      return opts.responsePayload ?? { ok: true, name }
    },
    close() {
      closed.value = true
    },
  }
  return { client, calls, connected, closed }
}

describe("parseRpcArgs", () => {
  it("parses a verb-only invocation", () => {
    const parsed = parseRpcArgs(["new-tab"])
    expect(parsed.verb).toBe("new-tab")
    expect(parsed.positional).toEqual([])
    expect(parsed.noWait).toBe(false)
  })

  it("captures positional args", () => {
    const parsed = parseRpcArgs(["switch-task", "task-42"])
    expect(parsed.verb).toBe("switch-task")
    expect(parsed.positional).toEqual(["task-42"])
  })

  it("recognises --no-wait anywhere in argv", () => {
    expect(parseRpcArgs(["new-tab", "--no-wait"]).noWait).toBe(true)
    expect(parseRpcArgs(["--no-wait", "new-tab"]).noWait).toBe(true)
    expect(parseRpcArgs(["switch-tab", "3", "--no-wait"]).noWait).toBe(true)
  })

  it("throws on missing verb", () => {
    expect(() => parseRpcArgs([])).toThrow(RpcError)
    expect(() => parseRpcArgs(["--no-wait"])).toThrow(RpcError)
  })

  it("throws on unknown flag", () => {
    expect(() => parseRpcArgs(["new-tab", "--something"])).toThrow(/unknown flag/)
  })
})

describe("routeVerb", () => {
  it("maps every documented verb to a daemon request", () => {
    expect(routeVerb("switch-task", ["t1"])).toEqual({
      name: "rpc.switchTask",
      payload: { id: "t1" },
    })
    expect(routeVerb("switch-tab", ["3"])).toEqual({
      name: "rpc.switchTab",
      payload: { tabId: "3" },
    })
    expect(routeVerb("new-tab", [])).toEqual({ name: "rpc.newTab", payload: {} })
    expect(routeVerb("close-tab", [])).toEqual({ name: "rpc.closeTab", payload: {} })
    expect(routeVerb("next-task", [])).toEqual({ name: "rpc.nextTask", payload: {} })
    expect(routeVerb("prev-task", [])).toEqual({ name: "rpc.prevTask", payload: {} })
  })

  it("rejects switch-task without an id", () => {
    expect(() => routeVerb("switch-task", [])).toThrow(/requires <id>/)
  })

  it("rejects switch-tab without an id", () => {
    expect(() => routeVerb("switch-tab", [])).toThrow(/requires <id\|index>/)
  })

  it("rejects unknown verbs", () => {
    expect(() => routeVerb("nope", [])).toThrow(/unknown verb/)
  })
})

describe("runRpc", () => {
  function captureIo() {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    }
  }

  it("issues the mapped request and prints the response for each verb", async () => {
    const verbs: Array<{ argv: string[]; expectedName: DaemonRequestName; expectedPayload: unknown }> = [
      { argv: ["switch-task", "t-9"], expectedName: "rpc.switchTask", expectedPayload: { id: "t-9" } },
      { argv: ["switch-tab", "2"], expectedName: "rpc.switchTab", expectedPayload: { tabId: "2" } },
      { argv: ["new-tab"], expectedName: "rpc.newTab", expectedPayload: {} },
      { argv: ["close-tab"], expectedName: "rpc.closeTab", expectedPayload: {} },
      { argv: ["next-task"], expectedName: "rpc.nextTask", expectedPayload: {} },
      { argv: ["prev-task"], expectedName: "rpc.prevTask", expectedPayload: {} },
    ]
    for (const { argv, expectedName, expectedPayload } of verbs) {
      const { client, calls, closed } = createFakeClient({
        responsePayload: { ok: true, name: expectedName },
      })
      const io = captureIo()
      const result = await runRpc(argv, {
        clientFactory: () => client,
        socketPath: "/tmp/unused.sock",
        stdout: io.stdout,
        stderr: io.stderr,
      })
      expect(result.exitCode).toBe(0)
      expect(calls).toEqual([{ name: expectedName, payload: expectedPayload }])
      expect(closed.value).toBe(true)
      const stdout = io.out.join("")
      expect(JSON.parse(stdout)).toEqual({ ok: true, name: expectedName })
      expect(io.err).toEqual([])
    }
  })

  it("with --no-wait does not await the response but still issues the request", async () => {
    const { client, calls, closed } = createFakeClient()
    const io = captureIo()
    const result = await runRpc(["new-tab", "--no-wait"], {
      clientFactory: () => client,
      socketPath: "/tmp/unused.sock",
      stdout: io.stdout,
      stderr: io.stderr,
    })
    expect(result.exitCode).toBe(0)
    // Request was kicked off even though we don't await it.
    expect(calls).toEqual([{ name: "rpc.newTab", payload: {} }])
    expect(closed.value).toBe(true)
    const stdout = io.out.join("")
    expect(JSON.parse(stdout)).toEqual({ ok: true, queued: true, name: "rpc.newTab" })
  })

  it("reports a hard error when the daemon socket is missing", async () => {
    const { client, calls } = createFakeClient({
      connectThrows: new Error("ENOENT: no such file"),
    })
    const io = captureIo()
    const result = await runRpc(["new-tab"], {
      clientFactory: () => client,
      socketPath: "/nope/daemon.sock",
      stdout: io.stdout,
      stderr: io.stderr,
    })
    expect(result.exitCode).toBe(2)
    expect(calls).toEqual([])
    const errBody = JSON.parse(io.err.join(""))
    expect(errBody.error.code).toBe("BAD_DAEMON")
    expect(errBody.error.message).toMatch(/no daemon at \/nope\/daemon.sock/)
  })

  it("surfaces RPC-side errors with exit code 1", async () => {
    const { client } = createFakeClient({
      requestThrows: new Error("orchestrator on fire"),
    })
    const io = captureIo()
    const result = await runRpc(["new-tab"], {
      clientFactory: () => client,
      socketPath: "/tmp/unused.sock",
      stdout: io.stdout,
      stderr: io.stderr,
    })
    expect(result.exitCode).toBe(1)
    const errBody = JSON.parse(io.err.join(""))
    expect(errBody.error.code).toBe("RPC_ERROR")
    expect(errBody.error.message).toMatch(/orchestrator on fire/)
  })

  it("rejects unknown verbs before opening a connection", async () => {
    const { client, connected } = createFakeClient()
    const io = captureIo()
    const result = await runRpc(["bogus-verb"], {
      clientFactory: () => client,
      socketPath: "/tmp/unused.sock",
      stdout: io.stdout,
      stderr: io.stderr,
    })
    expect(result.exitCode).toBe(2)
    expect(connected.value).toBe(false)
    const errBody = JSON.parse(io.err.join(""))
    expect(errBody.error.code).toBe("BAD_VERB")
  })

  it("rejects missing verb with MISSING_VERB", async () => {
    const { client, connected } = createFakeClient()
    const io = captureIo()
    const result = await runRpc([], {
      clientFactory: () => client,
      socketPath: "/tmp/unused.sock",
      stdout: io.stdout,
      stderr: io.stderr,
    })
    expect(result.exitCode).toBe(2)
    expect(connected.value).toBe(false)
    const errBody = JSON.parse(io.err.join(""))
    expect(errBody.error.code).toBe("MISSING_VERB")
  })
})
