import { basename } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { ensurePtyHostReachable } from "@sma1lboy/kobe-daemon/client/pty-process"
import { defaultPtyHostSocketPath } from "@sma1lboy/kobe-daemon/daemon/paths"
import type { PtyOpenResult, PtyPeekResult } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { PtySessionInfo } from "@sma1lboy/kobe-daemon/daemon/pty-host"
import { type PsSnapshot, engineProcessIn, parsePsSnapshot, psSnapshot } from "./foreground.ts"
import type { EngineSessionLaunch } from "./session-launch.ts"

export interface HostedSessionRpc {
  request<T = unknown>(name: string, payload?: unknown): Promise<T>
}

export interface HostedSessionClient {
  readonly rpc: HostedSessionRpc
  close(): void
}

async function connectHostedSessionClient(socketPath: string): Promise<HostedSessionClient> {
  const client = new KobeDaemonClient(socketPath)
  try {
    await client.connect()
  } catch (error) {
    client.close()
    throw error
  }
  return { rpc: client, close: () => client.close() }
}

/** Non-mutating probe used by liveness and teardown paths. */
export async function openHostedSessionHost(): Promise<HostedSessionClient | null> {
  try {
    return await connectHostedSessionClient(defaultPtyHostSocketPath())
  } catch {
    return null
  }
}

/** Start the host when necessary, then connect a short-lived client. */
export async function ensureHostedSessionHost(): Promise<HostedSessionClient> {
  return connectHostedSessionClient(await ensurePtyHostReachable())
}

export async function listHostedSessions(rpc: HostedSessionRpc): Promise<PtySessionInfo[]> {
  try {
    const { sessions } = await rpc.request<{ sessions: PtySessionInfo[] }>("pty.list", {})
    return sessions ?? []
  } catch {
    return []
  }
}

export function isHostedTaskKey(key: string, taskId: string): boolean {
  return (key.split("::")[0] ?? key) === taskId
}

export function hostedTaskKeys(sessions: readonly PtySessionInfo[], taskId: string): string[] {
  return sessions.filter((session) => isHostedTaskKey(session.key, taskId)).map((session) => session.key)
}

export async function killHostedSessions(rpc: HostedSessionRpc, keys: readonly string[]): Promise<void> {
  for (const key of keys) await rpc.request("pty.kill", { key }).catch(() => {})
}

/**
 * True when a session's spawn argv contains `engineBin` as a standalone
 * word. Hosted engine tabs launch via `<shell> -ilc '…<engineBin> …'`
 * (`buildEngineSessionLaunch`), so `command[0]` is ALWAYS the shell — an
 * argv[0] comparison against the engine binary never matches in production
 * (issue #19: that dead fallback made delivery silently spawn a duplicate
 * engine). Bare shell tabs (`[shell, "-il"]`) carry no engine word.
 */
export function commandHasEngineWord(command: readonly string[], engineBin: string): boolean {
  for (const part of command) {
    for (const token of part.split(/\s+/)) {
      const bare = token.replace(/^['"]+|['"]+$/g, "")
      if (bare && basename(bare) === engineBin) return true
    }
  }
  return false
}

/**
 * Pick the ALIVE engine session key for `taskId`, or `null` when none.
 * Preference order: the deterministic `<taskId>::tab-1` engine tab, then any
 * alive tab whose launch argv contains `engineBin` as a word (a renumbered
 * or `--tab new` engine surviving tab-1's death). Bare shell tabs never
 * match — they must never receive a prompt.
 */
export function findHostedEngineKey(
  sessions: readonly PtySessionInfo[],
  taskId: string,
  engineBin?: string,
): string | null {
  const mine = sessions.filter((s) => s.alive && isHostedTaskKey(s.key, taskId))
  const tab1 = mine.find((s) => s.key === `${taskId}::tab-1`)
  if (tab1) return tab1.key
  if (engineBin) {
    const byCommand = mine.find((s) => commandHasEngineWord(s.command, engineBin))
    if (byCommand) return byCommand.key
  }
  return null
}

/** Delay between bracketed paste and submit CR so the engine reads two tty events. */
const SUBMIT_DELAY_MS = 150

/** Bracketed-paste the prompt, wait, then submit — the pty twin of `pasteAndSubmit`. */
export async function writeHostedPrompt(rpc: HostedSessionRpc, key: string, prompt: string): Promise<void> {
  await rpc.request("pty.write", { key, data: `\x1b[200~${prompt}\x1b[201~` })
  await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS))
  await rpc.request("pty.write", { key, data: "\r" })
}

/**
 * Deliver `prompt` into an existing hosted engine session and submit it.
 * Returns whether the session was alive to receive it.
 *
 * `pty.peek`, NOT `pty.open`: an open from this headless client would
 * last-attach-wins resize a live session out from under the attached TUI
 * (the engine repaints at the delivery client's size and the pane garbles
 * — issue #18), and an open for a key that just died would spawn a bare
 * shell and paste the prompt into it. Peek never attaches, spawns, or
 * resizes — delivery is pure `pty.write`, exactly like keyboard input.
 */
export async function deliverToHostedKey(rpc: HostedSessionRpc, key: string, prompt: string): Promise<boolean> {
  const peek = await rpc.request<PtyPeekResult>("pty.peek", { key })
  if (!peek.alive) return false
  await writeHostedPrompt(rpc, key, prompt)
  return true
}

/** Open or reattach one engine session and immediately release this client.
 *  No cols/rows: a size-less open never resizes a live session away from
 *  its attached TUI (the host only sizes the spawn, defaulting 80×24). */
export async function ensureHostedEngine(
  rpc: HostedSessionRpc,
  cwd: string,
  launch: EngineSessionLaunch,
): Promise<PtyOpenResult> {
  const result = await rpc.request<PtyOpenResult>("pty.open", {
    key: launch.key,
    cwd,
    command: launch.command,
  })
  await rpc.request("pty.detach", { key: launch.key }).catch(() => {})
  return result
}

/** Bounds for the first-message readiness wait (paste-delivery vendors). */
export const FIRST_MESSAGE_ENGINE_TIMEOUT_MS = 20_000
export const FIRST_MESSAGE_POLL_INTERVAL_MS = 500
/** Post-detection grace so the TUI finishes booting (bracketed-paste mode on). */
export const FIRST_MESSAGE_SETTLE_MS = 1_500

export interface PasteFirstMessageOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
  readonly settleMs?: number
  /** Test seam for the process-table read (see `pty-delivery.ts`'s gate). */
  readonly snapshot?: PsSnapshot
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Deliver a paste-delivery vendor's FIRST message (issue #25): the launch
 * spawned the bare engine (its positional argv slot is a subcommand, not a
 * prompt), so the prompt is bracketed-pasted once the engine process is
 * actually up — the same reason `send` into a cold engine embeds nowhere
 * but waits here instead. Polls the session's process tree until an engine
 * child appears (or the session dies / the wait budget runs out), grants a
 * short settle for the TUI to finish initializing, then pastes + submits.
 * Returns whether the paste happened.
 */
export async function pastePromptWhenEngineUp(
  rpc: HostedSessionRpc,
  key: string,
  engineBin: string | undefined,
  prompt: string,
  opts: PasteFirstMessageOptions = {},
): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const snapshot = opts.snapshot ?? psSnapshot
  const deadline = Date.now() + (opts.timeoutMs ?? FIRST_MESSAGE_ENGINE_TIMEOUT_MS)
  while (Date.now() < deadline) {
    const { sessions = [] } = await rpc.request<{ sessions?: PtySessionInfo[] }>("pty.list", {})
    const session = sessions.find((s) => s.key === key)
    if (!session?.alive) return false
    if (session.pid) {
      let up = false
      try {
        up = engineProcessIn(parsePsSnapshot(await snapshot()), session.pid, engineBin)
      } catch {
        up = false // ps hiccup — treat as "not yet", keep polling
      }
      if (up) {
        await sleep(opts.settleMs ?? FIRST_MESSAGE_SETTLE_MS)
        await writeHostedPrompt(rpc, key, prompt)
        return true
      }
    }
    await sleep(opts.intervalMs ?? FIRST_MESSAGE_POLL_INTERVAL_MS)
  }
  return false
}
