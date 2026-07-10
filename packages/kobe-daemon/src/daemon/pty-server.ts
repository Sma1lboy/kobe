/**
 * Standalone PTY host server — kobe's tmux-server analog.
 *
 * Runs as its own detached process (`kobe pty-host`), on its own unix
 * socket, deliberately OUTSIDE the daemon: the daemon restarts routinely
 * (it holds the fast-moving code), while this process is tiny, stable,
 * and must keep embedded-terminal children alive across both TUI exits
 * and daemon restarts. Only `kobe reset` (or idle-exit at zero live
 * sessions, like tmux) ends it.
 *
 * Wire: the same JSON-lines frame grammar as the daemon socket
 * (`protocol.ts`), so `KobeDaemonClient` speaks it unchanged. Every
 * outbound frame is written CRITICAL — this socket carries only ordered
 * PTY byte streams and RPC responses, neither of which may be dropped;
 * the ring-buffer cap bounds what a session can queue.
 *
 * Requests served: `hello` (reachability probe), `pty.open/write/resize/
 * kill/detach/list`, `pty.sweep` (daemon janitor: kill sessions of
 * archived tasks), `daemon.stop` (reset teardown — shared with
 * `stopDaemonProcess`'s graceful path).
 */

import { mkdir, unlink, writeFile } from "node:fs/promises"
import { type Server, type Socket, createServer } from "node:net"
import { dirname } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { ClientWriter } from "./client-writer.ts"
import { logDaemonError } from "./crash-log.ts"
import { objectPayload, requireString } from "./handler-validators.ts"
import { defaultPtyHostPidPath, defaultPtyHostSocketPath } from "./paths.ts"
import { DAEMON_PROTOCOL_VERSION, type DaemonFrame, frameToLine } from "./protocol.ts"
import { PtyHost } from "./pty-host.ts"

/**
 * Grace before a host with ZERO live sessions exits (tmux exits at zero
 * sessions too — the grace absorbs the boot window before the first
 * `pty.open` and quick close→reopen cycles). Override via
 * `KOBE_PTY_IDLE_EXIT_MS`.
 */
const DEFAULT_IDLE_EXIT_MS = 60_000

function resolveIdleExitMs(): number {
  const raw = process.env.KOBE_PTY_IDLE_EXIT_MS
  if (raw === undefined) return DEFAULT_IDLE_EXIT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_EXIT_MS
}

export interface PtyHostServerOptions {
  readonly socketPath?: string
  readonly pidPath?: string
  /** Grace before a zero-live-session host exits; `0` uses the default. */
  readonly idleExitMs?: number
  /** Called after close() when the host stops itself (idle / daemon.stop). */
  readonly onStop?: () => void
  readonly log?: (event: string, message: string) => void
}

export interface PtyHostServer {
  readonly socketPath: string
  readonly pidPath: string
  close(): Promise<void>
}

interface PtyClientState {
  socket: Socket
  writer: ClientWriter
  buffer: string
}

export async function startPtyHostServer(options: PtyHostServerOptions = {}): Promise<PtyHostServer> {
  const socketPath = options.socketPath ?? defaultPtyHostSocketPath()
  const pidPath = options.pidPath ?? defaultPtyHostPidPath()
  const idleExitMs = options.idleExitMs || resolveIdleExitMs()
  const log = options.log ?? (() => {})
  const clients = new Set<PtyClientState>()
  let stopping = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const cancelIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }
  // Zero LIVE sessions → exit after a grace, like the tmux server. NOT
  // unref'd: this timer being the only pending work is exactly the state
  // it exists to resolve.
  const armIdle = (): void => {
    if (stopping) return
    cancelIdle()
    idleTimer = setTimeout(() => {
      if (stopping || ptys.liveCount() > 0) return
      log("idle", `no live sessions for ${idleExitMs}ms — exiting`)
      void stop()
    }, idleExitMs)
  }

  const ptys = new PtyHost({
    onSessionStart: cancelIdle,
    onSessionEnd: () => {
      if (ptys.liveCount() === 0) armIdle()
    },
    log,
  })

  await mkdir(dirname(socketPath), { recursive: true })
  await mkdir(dirname(pidPath), { recursive: true })
  // Never unlink before listen: an already-running host keeps its socket
  // alive after unlink, so a second host could bind the same pathname,
  // overwrite the pidfile, and strand the first host's live sessions.
  // `ensurePtyHostReachable()` clears only a confirmed-stale socket through
  // stopDaemonProcess before it spawns us.

  const server: Server = createServer((socket) => {
    const client: PtyClientState = { socket, writer: new ClientWriter(socket), buffer: "" }
    clients.add(client)
    const decoder = new StringDecoder("utf8")
    socket.on("data", (chunk) => {
      client.buffer += decoder.write(chunk)
      drain(client)
    })
    socket.on("error", () => {})
    socket.on("close", () => {
      clients.delete(client)
      // Children keep running — only this connection's fan-out stops.
      ptys.detachClient(client)
    })
  })

  const api: PtyHostServer = {
    socketPath,
    pidPath,
    async close() {
      if (stopping) return
      stopping = true
      cancelIdle()
      // The host process IS the sessions' lifetime — ending it ends them.
      await ptys.killAll()
      for (const client of Array.from(clients)) client.socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(socketPath).catch(() => {})
      await unlink(pidPath).catch(() => {})
    },
  }

  async function stop(): Promise<void> {
    await api.close().catch((err) => logDaemonError("pty-host-shutdown", err))
    options.onStop?.()
  }

  function dispatch(req: Extract<DaemonFrame, { type: "request" }>, client: PtyClientState): unknown {
    switch (req.name) {
      case "hello":
        return { protocolVersion: DAEMON_PROTOCOL_VERSION, ptyHost: true, pid: process.pid }
      case "pty.open": {
        const payload = objectPayload(req.payload)
        return ptys.open(
          requireString(payload, "key"),
          {
            cwd: requireString(payload, "cwd"),
            command: Array.isArray(payload.command)
              ? payload.command.filter((c): c is string => typeof c === "string")
              : undefined,
            shell: typeof payload.shell === "string" ? payload.shell : undefined,
            cols: typeof payload.cols === "number" ? payload.cols : 80,
            rows: typeof payload.rows === "number" ? payload.rows : 24,
          },
          client,
          (frame) => writeFrame(client, frame),
        )
      }
      case "pty.write": {
        const payload = objectPayload(req.payload)
        ptys.write(requireString(payload, "key"), typeof payload.data === "string" ? payload.data : "")
        return {}
      }
      case "pty.resize": {
        const payload = objectPayload(req.payload)
        ptys.resize(
          requireString(payload, "key"),
          typeof payload.cols === "number" ? payload.cols : 80,
          typeof payload.rows === "number" ? payload.rows : 24,
        )
        return {}
      }
      case "pty.kill":
        ptys.kill(requireString(objectPayload(req.payload), "key"))
        return {}
      case "pty.detach":
        ptys.detach(requireString(objectPayload(req.payload), "key"), client)
        return {}
      case "pty.list":
        return { sessions: ptys.list() }
      case "pty.sweep": {
        const payload = objectPayload(req.payload)
        const ids = Array.isArray(payload.liveTaskIds)
          ? payload.liveTaskIds.filter((id): id is string => typeof id === "string")
          : []
        ptys.sweepTasks(new Set(ids))
        return {}
      }
      case "daemon.stop":
        // Shared graceful-stop verb so `stopDaemonProcess` (kobe reset)
        // works against this socket unchanged.
        setTimeout(() => void stop(), 0).unref()
        return {}
      default:
        throw new Error(`unknown pty-host request: ${req.name}`)
    }
  }

  function drain(client: PtyClientState): void {
    let nl = client.buffer.indexOf("\n")
    while (nl !== -1) {
      const line = client.buffer.slice(0, nl)
      client.buffer = client.buffer.slice(nl + 1)
      if (line.trim().length > 0) {
        let frame: DaemonFrame | null = null
        try {
          frame = JSON.parse(line) as DaemonFrame
        } catch {
          writeFrame(client, { type: "response", id: "parse-error", error: { message: "malformed frame" } })
        }
        if (frame) {
          if (frame.type !== "request") {
            writeFrame(client, { type: "response", id: "parse-error", error: { message: "requests only" } })
          } else {
            try {
              writeFrame(client, { type: "response", id: frame.id, name: frame.name, payload: dispatch(frame, client) })
            } catch (err) {
              writeFrame(client, {
                type: "response",
                id: frame.id,
                name: frame.name,
                error: { message: err instanceof Error ? err.message : String(err) },
              })
            }
          }
        }
      }
      nl = client.buffer.indexOf("\n")
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })
  await writeFile(pidPath, `${process.pid}\n`, "utf8")
  armIdle()
  log("boot", `pty host listening on ${socketPath}`)
  return api
}

function writeFrame(client: Pick<PtyClientState, "writer">, frame: DaemonFrame): void {
  // Everything on this socket is critical: RPC responses and ordered PTY
  // byte-stream frames — dropping either corrupts the client.
  client.writer.write(frameToLine(frame), true)
}
