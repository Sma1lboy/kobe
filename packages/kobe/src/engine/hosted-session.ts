import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { ensurePtyHostReachable } from "@sma1lboy/kobe-daemon/client/pty-process"
import { defaultPtyHostSocketPath } from "@sma1lboy/kobe-daemon/daemon/paths"
import type { PtyOpenResult } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { PtySessionInfo } from "@sma1lboy/kobe-daemon/daemon/pty-host"
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
 * Pick the ALIVE engine session key for `taskId`, or `null` when none.
 * Preference order: the deterministic `<taskId>::tab-1` engine tab, then a
 * session whose `command[0]` matches `engineBin` (a reattached/renumbered
 * engine). Bare shell tabs never match — they must never receive a prompt.
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
    const byCommand = mine.find((s) => s.command[0] === engineBin)
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
 * `pty.open` REATTACHES (spec ignored for a live key — never spawns).
 * Returns whether the session was alive to receive it.
 */
export async function deliverToHostedKey(
  rpc: HostedSessionRpc,
  key: string,
  cwd: string,
  prompt: string,
): Promise<boolean> {
  const open = await rpc.request<PtyOpenResult>("pty.open", { key, cwd, cols: 80, rows: 24 })
  if (!open.alive) return false
  await writeHostedPrompt(rpc, key, prompt)
  return true
}

/** Open or reattach one engine session and immediately release this client. */
export async function ensureHostedEngine(
  rpc: HostedSessionRpc,
  cwd: string,
  launch: EngineSessionLaunch,
): Promise<PtyOpenResult> {
  const result = await rpc.request<PtyOpenResult>("pty.open", {
    key: launch.key,
    cwd,
    command: launch.command,
    cols: 80,
    rows: 24,
  })
  await rpc.request("pty.detach", { key: launch.key }).catch(() => {})
  return result
}
