/**
 * `kobe mcp-bridge --socket=<path>` — MCP stdio server that proxies
 * tool calls to a running kobe TUI via its Unix-socket bridge.
 *
 * Lifecycle: claude (running inside a kobe-spawned task) starts this
 * process as one of its `--mcp-config` entries. We speak MCP/JSON-RPC
 * 2.0 over stdio (newline-delimited frames), and forward each
 * `tools/call` to the Unix socket the parent kobe wrote at startup.
 *
 * Why a separate subprocess at all: claude spawns MCP servers itself;
 * it doesn't talk to "the kobe process that started me." So the
 * bridge is a thin shim — load the socket path, translate frames,
 * surface errors as MCP tool errors. The bridge keeps no state.
 */

import { type Socket, connect } from "node:net"

interface JsonRpcMessage {
  jsonrpc: "2.0"
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOLS: ToolDef[] = [
  {
    name: "kobe_spawn_task",
    description:
      "Spawn a new kobe task. Creates a chat tab + worktree under the requested repo and starts the agent with `prompt`. Returns the task id; the spawned task runs in parallel and the user sees it in the sidebar.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Absolute path to the git repo (must already be a saved repo in kobe).",
        },
        prompt: {
          type: "string",
          description: "First user prompt sent to the spawned agent.",
        },
        title: {
          type: "string",
          description: "Optional sidebar title. When omitted kobe auto-derives it from the prompt.",
        },
        base_branch: {
          type: "string",
          description: "Optional base ref for the new branch (e.g. 'main'). Defaults to repo HEAD.",
        },
      },
      required: ["repo", "prompt"],
    },
  },
  {
    name: "kobe_list_tasks",
    description: "List all tasks currently visible in the kobe sidebar (id, title, status, branch, worktree path).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kobe_get_task",
    description: "Fetch a single task by id.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "kobe_send_message",
    description: "Send a follow-up prompt to an existing task. Resumes the underlying agent session.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["task_id", "prompt"],
    },
  },
]

const PROTOCOL_VERSION = "2024-11-05"

/**
 * Single persistent connection to the kobe Unix socket. We pipeline
 * requests through it keyed by a monotonic counter so multiple
 * in-flight tool calls don't tangle — even though MCP sequential
 * makes this rare, the cost is two ints.
 */
class SocketClient {
  private readonly socket: Socket
  private buffer = ""
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private connected: Promise<void>

  constructor(path: string, onClose?: () => void) {
    this.socket = connect(path)
    this.connected = new Promise<void>((resolve, reject) => {
      this.socket.once("connect", resolve)
      this.socket.once("error", reject)
    })
    this.socket.on("data", (chunk) => this.onData(chunk.toString("utf8")))
    this.socket.on("close", () => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error("kobe bridge socket closed"))
      }
      this.pending.clear()
      onClose?.()
    })
  }

  private onData(text: string): void {
    this.buffer += text
    let nl = this.buffer.indexOf("\n")
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.trim().length > 0) this.handleLine(line)
      nl = this.buffer.indexOf("\n")
    }
  }

  private handleLine(line: string): void {
    let parsed: { id?: number | string; result?: unknown; error?: { message: string } }
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const id = typeof parsed.id === "number" ? parsed.id : null
    if (id === null) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message))
    } else {
      pending.resolve(parsed.result)
    }
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.connected
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.socket.write(`${JSON.stringify({ id, method, params })}\n`)
    return promise
  }
}

/**
 * Read newline-framed JSON-RPC requests on stdin; write responses to
 * stdout. MCP stdio servers must keep stderr free for free-form logs
 * — never write protocol frames to stderr.
 */
async function runMcpStdioLoop(client: SocketClient): Promise<void> {
  let buffer = ""
  for await (const chunk of process.stdin as unknown as AsyncIterable<Buffer>) {
    buffer += chunk.toString("utf8")
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim().length > 0) {
        await handleMcpFrame(client, line)
      }
      nl = buffer.indexOf("\n")
    }
  }
}

async function handleMcpFrame(client: SocketClient, line: string): Promise<void> {
  let msg: JsonRpcMessage
  try {
    msg = JSON.parse(line)
  } catch (err) {
    process.stderr.write(`mcp-bridge: bad json: ${err instanceof Error ? err.message : String(err)}\n`)
    return
  }

  // Notifications carry no id; we just acknowledge by silence.
  if (msg.id === undefined || msg.id === null) {
    return
  }

  const reply = (result: unknown): void => {
    const out: JsonRpcMessage = { jsonrpc: "2.0", id: msg.id, result }
    process.stdout.write(`${JSON.stringify(out)}\n`)
  }
  const fail = (code: number, message: string): void => {
    const out: JsonRpcMessage = { jsonrpc: "2.0", id: msg.id, error: { code, message } }
    process.stdout.write(`${JSON.stringify(out)}\n`)
  }

  try {
    switch (msg.method) {
      case "initialize":
        reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "kobe", version: "0.1.0" },
        })
        return
      case "tools/list":
        reply({ tools: TOOLS })
        return
      case "tools/call": {
        const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
        const name = params.name
        const args = params.arguments ?? {}
        if (!name) {
          fail(-32602, "missing tool name")
          return
        }
        const result = await invokeTool(client, name, args)
        reply({
          content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
        })
        return
      }
      default:
        fail(-32601, `method not found: ${msg.method}`)
        return
    }
  } catch (err) {
    fail(-32000, err instanceof Error ? err.message : String(err))
  }
}

async function invokeTool(client: SocketClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "kobe_spawn_task":
      return await client.call("spawn_task", args)
    case "kobe_list_tasks":
      return await client.call("list_tasks", {})
    case "kobe_get_task":
      return await client.call("get_task", args)
    case "kobe_send_message":
      return await client.call("send_message", args)
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

/** Entry point invoked from `src/cli/index.ts` when argv[2] === "mcp-bridge". */
export async function runMcpBridgeSubcommand(argv: readonly string[]): Promise<void> {
  let socketPath: string | undefined
  for (const arg of argv) {
    if (arg.startsWith("--socket=")) socketPath = arg.slice("--socket=".length)
  }
  if (!socketPath) {
    process.stderr.write("mcp-bridge: --socket=<path> is required\n")
    process.exit(2)
  }

  // Self-terminate when orphaned. claude spawns us as an MCP child;
  // when claude is SIGKILLed by the orchestrator's session-stop path,
  // our stdin pipe doesn't always EOF us (Bun runtime quirk), so we
  // can survive indefinitely as a PPID=1 zombie. Without this watchdog,
  // every spawn → kill cycle leaks one mcp-bridge — we observed 55
  // accumulated over a few hours of dev iteration.
  let exiting = false
  const exitOnce = (code = 0) => {
    if (exiting) return
    exiting = true
    process.exit(code)
  }
  const initialPpid = process.ppid
  const ppidWatcher = setInterval(() => {
    const current = process.ppid
    if (current !== initialPpid || current === 1) exitOnce()
  }, 1000)
  ppidWatcher.unref?.()

  process.stdin.once("end", () => exitOnce())
  process.stdin.once("close", () => exitOnce())
  process.once("SIGTERM", () => exitOnce())
  process.once("SIGINT", () => exitOnce())

  const client = new SocketClient(socketPath, () => exitOnce())
  await runMcpStdioLoop(client)
  exitOnce()
}
