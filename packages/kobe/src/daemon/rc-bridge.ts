/**
 * Daemon-side manager for `claude remote-control` (the bridge daemon
 * that registers this machine as an environment claude.ai can spawn
 * sessions onto).
 *
 * One instance per kobed. Off by default; user toggles it from the
 * settings dialog. While running, the workspace top bar shows an "RC"
 * chip with the environment ID; the dialog also surfaces the
 * `https://claude.ai/code?environment=env_xxx` deeplink so the user
 * can hop over from another device.
 *
 * Implementation notes:
 *
 *   - We spawn `claude remote-control --verbose` with stdin: ignore.
 *     The daemon doesn't need a TTY (verified in S1, KOB-62) — its
 *     interactive UI keystrokes (space, w) are nice-to-haves we don't
 *     use. Workers it spawns use the standard `--print stream-json`
 *     mode internally and aren't our concern.
 *
 *   - State is stored in memory only. If kobed restarts the bridge
 *     dies with it; user re-enables via settings. (Persisting an
 *     "auto-start on kobed boot" preference is a follow-up.)
 *
 *   - Lifecycle: start → starting → running → (proc exits OR stop()) →
 *     off / error. `stop()` is graceful (SIGTERM, 5s grace, SIGKILL),
 *     because the bridge needs the grace period to deregister its
 *     environment from Anthropic's API (otherwise the environment
 *     lingers as "online" on claude.ai for the heartbeat timeout).
 */

import { type ChildProcessByStdio, spawn } from "node:child_process"
import type { Readable } from "node:stream"
import { findClaudeBinary } from "../engine/claude-code-local/binary.ts"

/**
 * What we need from a spawned bridge process. Tighter than `ChildProcess`
 * (no stdin — we spawn with `stdio: ["ignore", "pipe", "pipe"]`) and
 * narrower than `ChildProcessWithoutNullStreams`. Tests pass a fake
 * matching this shape.
 */
type RcBridgeChild = ChildProcessByStdio<null, Readable, Readable>

/** Lifecycle state of the bridge process. */
export type RcBridgeState = "off" | "starting" | "running" | "stopping" | "error"

/**
 * Identity of the kobe chat tab whose worktree the bridge is currently
 * sharing. Set on `start()` and surfaced through `status` so the dialog
 * can render "you're sharing X (resume sessionId Y)" instead of just an
 * opaque env id. The daemon never validates these — the server-side
 * dispatch in `daemon/server.ts` looks up the task from its real id and
 * fills these in before calling `start()`.
 */
export interface RcBridgeBoundTab {
  readonly taskId: string
  readonly tabId: string
  /**
   * The kobe session id (UUID) the user can `/resume <sid>` in claude.ai
   * to continue the in-flight conversation rather than starting a fresh
   * one. Null/undefined when the tab hasn't run a turn yet — share-mode
   * still works in that case (claude.ai gets a fresh session in the
   * worktree), but there's nothing to resume.
   */
  readonly sessionId?: string | null
  /** Task title at the moment of bind, for dialog display. */
  readonly taskTitle?: string
}

/** Wire-shaped snapshot of the bridge for `rcBridge.status` responses + `rcBridge.changed` events. */
export interface RcBridgeStatus {
  readonly state: RcBridgeState
  readonly envId?: string
  readonly deeplink?: string
  readonly cwd?: string
  readonly pid?: number
  readonly startedAt?: string
  readonly errorMessage?: string
  readonly bound?: RcBridgeBoundTab
}

/** Test injection seam — production callers pass nothing. */
export interface RcBridgeOptions {
  /** Override the binary discovery (used by tests with a fake script). */
  readonly binaryPathResolver?: () => Promise<string>
  /**
   * Override the spawn step entirely. Tests pass a fake that emits
   * canned stdout (e.g. `Environment ID: env_test\n`) and an exit
   * event on demand.
   */
  readonly spawner?: (cmd: string, args: readonly string[], cwd: string) => RcBridgeChild
  /** Grace period for SIGTERM before SIGKILL. Default 5s. */
  readonly stopGraceMs?: number
  /** How long to wait for the daemon to print `Environment ID:` before giving up. Default 30s. */
  readonly readyTimeoutMs?: number
}

export interface RcBridge {
  start(opts: { cwd: string; bound?: RcBridgeBoundTab }): Promise<RcBridgeStatus>
  stop(): Promise<RcBridgeStatus>
  status(): RcBridgeStatus
  /** Subscribe to status transitions. Returns an unsubscribe function. */
  onChange(cb: (status: RcBridgeStatus) => void): () => void
}

const ENV_ID_RE = /Environment ID:\s*(env_[A-Za-z0-9]+)/
const DEEPLINK_RE = /https:\/\/claude\.ai\/code\?environment=([A-Za-z0-9_]+)/
// Drop ANSI escape sequences before pattern-matching — the bridge UI
// repaints constantly and wraps the env id in cursor-positioning codes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape (0x1B) is the point of the pattern
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

export function createRcBridge(options: RcBridgeOptions = {}): RcBridge {
  const stopGraceMs = options.stopGraceMs ?? 5_000
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000
  const binaryPathResolver = options.binaryPathResolver ?? findClaudeBinary
  const spawner =
    options.spawner ??
    ((cmd, args, cwd): RcBridgeChild =>
      spawn(cmd, [...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      }))

  const subscribers = new Set<(status: RcBridgeStatus) => void>()
  let snapshot: RcBridgeStatus = { state: "off" }
  let proc: RcBridgeChild | null = null
  let stdoutBuffer = ""
  let stderrBuffer = ""
  let readyResolve: ((status: RcBridgeStatus) => void) | null = null
  let readyReject: ((err: Error) => void) | null = null
  let readyTimer: ReturnType<typeof setTimeout> | null = null

  function update(next: RcBridgeStatus): RcBridgeStatus {
    snapshot = next
    for (const cb of subscribers) {
      try {
        cb(snapshot)
      } catch {
        // Subscriber errors must never propagate back into lifecycle code.
      }
    }
    return snapshot
  }

  function clearReadyTimer(): void {
    if (readyTimer) {
      clearTimeout(readyTimer)
      readyTimer = null
    }
  }

  function settleReady(status: RcBridgeStatus): void {
    clearReadyTimer()
    const resolve = readyResolve
    readyResolve = null
    readyReject = null
    if (resolve) resolve(status)
  }

  function failReady(err: Error): void {
    clearReadyTimer()
    const reject = readyReject
    readyResolve = null
    readyReject = null
    if (reject) reject(err)
  }

  function onStdout(chunk: Buffer): void {
    const text = chunk.toString("utf8").replace(ANSI_RE, "")
    stdoutBuffer = (stdoutBuffer + text).slice(-4096)
    if (snapshot.state !== "starting" && snapshot.state !== "running") return
    const envMatch = stdoutBuffer.match(ENV_ID_RE)
    const linkMatch = stdoutBuffer.match(DEEPLINK_RE)
    if (envMatch && snapshot.envId !== envMatch[1]) {
      const envId = envMatch[1]
      const deeplink = linkMatch
        ? `https://claude.ai/code?environment=${linkMatch[1]}`
        : `https://claude.ai/code?environment=${envId}`
      const ready = update({
        ...snapshot,
        state: "running",
        envId,
        deeplink,
      })
      settleReady(ready)
    }
  }

  function onStderr(chunk: Buffer): void {
    stderrBuffer = (stderrBuffer + chunk.toString("utf8")).slice(-4096)
  }

  function onExit(code: number | null, signal: NodeJS.Signals | null): void {
    proc = null
    const wasStopping = snapshot.state === "stopping"
    if (wasStopping) {
      update({ state: "off" })
      settleReady(snapshot)
      return
    }
    // Unexpected exit: surface tail of stderr (or stdout) so the dialog
    // can show a useful message (auth failure, workspace not trusted, etc.).
    const tail = (text: string): string => text.trim().split("\n").slice(-3).join("\n")
    const msg =
      tail(stderrBuffer) || tail(stdoutBuffer) || `claude remote-control exited (code=${code}, signal=${signal})`
    const errored = update({ state: "error", errorMessage: msg })
    failReady(new Error(errored.errorMessage ?? "claude remote-control exited"))
  }

  return {
    status() {
      return snapshot
    },
    onChange(cb) {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    async start(opts) {
      if (snapshot.state === "running" || snapshot.state === "starting") return snapshot
      const binary = await binaryPathResolver()
      stdoutBuffer = ""
      stderrBuffer = ""
      update({
        state: "starting",
        cwd: opts.cwd,
        startedAt: new Date().toISOString(),
        bound: opts.bound,
      })
      const args = ["remote-control", "--verbose", "--remote-control-session-name-prefix", "kobe"]
      let child: RcBridgeChild
      try {
        child = spawner(binary, args, opts.cwd)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        update({ state: "error", errorMessage: `failed to spawn: ${msg}` })
        throw err
      }
      proc = child
      update({ ...snapshot, pid: child.pid ?? undefined })
      child.stdout.on("data", onStdout)
      child.stderr.on("data", onStderr)
      child.once("exit", onExit)
      child.once("error", (err) => {
        proc = null
        update({ state: "error", errorMessage: err.message })
        failReady(err)
      })
      return new Promise<RcBridgeStatus>((resolve, reject) => {
        readyResolve = resolve
        readyReject = reject
        readyTimer = setTimeout(() => {
          // Daemon never printed Environment ID — kill it and report.
          if (proc) {
            try {
              proc.kill("SIGTERM")
            } catch {
              /* proc may already be gone */
            }
          }
          update({ state: "error", errorMessage: `timed out waiting for environment id (${readyTimeoutMs}ms)` })
          failReady(new Error(`claude remote-control did not become ready within ${readyTimeoutMs}ms`))
        }, readyTimeoutMs)
        readyTimer.unref?.()
      })
    },
    async stop() {
      const child = proc
      if (!child || (snapshot.state !== "running" && snapshot.state !== "starting")) {
        if (snapshot.state !== "off") update({ state: "off" })
        return snapshot
      }
      update({ ...snapshot, state: "stopping" })
      const onExitPromise = new Promise<void>((resolve) => {
        const onceExit = (): void => resolve()
        child.once("exit", onceExit)
      })
      try {
        child.kill("SIGTERM")
      } catch {
        /* proc may already be gone */
      }
      const killTimer = setTimeout(() => {
        if (proc === child) {
          try {
            child.kill("SIGKILL")
          } catch {
            /* proc may already be gone */
          }
        }
      }, stopGraceMs)
      killTimer.unref?.()
      await onExitPromise
      clearTimeout(killTimer)
      // onExit already transitioned state to "off". Return that snapshot.
      return snapshot
    },
  }
}
