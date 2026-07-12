/**
 * PTY Host prompt delivery for `kobe api`. The standalone `kobe pty-host`
 * process is the only owner of interactive engine sessions; API automation
 * reuses the canonical engine key or creates it from the shared launch spec.
 *
 * pty.* frames are served by the pty-host on its OWN socket (NOT proxied
 * through the daemon — see `kobe-daemon/daemon/pty-server.ts`), so this
 * module opens its own short-lived client to `defaultPtyHostSocketPath()`,
 * exactly like the `pty-list` verb does. Nothing here is engine-specific:
 * the engine key is found by the DETERMINISTIC `<taskId>::tab-1` the TUI
 * always assigns its first (engine) tab, refined by an argv match against
 * the vendor's own launch binary — never a hard-coded "claude"/"codex".
 */

import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { ensurePtyHostReachable } from "@sma1lboy/kobe-daemon/client/pty-process"
import { defaultPtyHostSocketPath } from "@sma1lboy/kobe-daemon/daemon/paths"
import type { PtyOpenResult } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { PtySessionInfo } from "@sma1lboy/kobe-daemon/daemon/pty-host"
import type { EngineSessionLaunch } from "../../engine/session-launch.ts"
import type { DeliveredPrompt } from "./types.ts"

/**
 * The narrow pty-host surface this module needs: request/response RPC plus
 * cleanup. `KobeDaemonClient` satisfies it; tests inject a fake that
 * records requests instead of opening a socket.
 */
export interface PtyHostRpc {
  request<T = unknown>(name: string, payload?: unknown): Promise<T>
}

/** Delay between the bracketed paste and the submit CR so the engine reads
 *  them as two tty reads — mirrors the tmux path's `SUBMIT_DELAY_MS`. */
const SUBMIT_DELAY_MS = 150

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A key belongs to `taskId` when its segment before the first `::` matches
 * — the same split `pty-host.ts` `sweepTasks` uses. `tab-1` is the engine
 * tab the TUI's `initialTabs()` always mints first.
 */
export function isTaskKey(key: string, taskId: string): boolean {
  return (key.split("::")[0] ?? key) === taskId
}

/**
 * Pick the ALIVE engine session key for `taskId`, or `null` when none —
 * the single source of truth both delivery and liveness route through, so
 * "no engine" NEVER falls through to spawning a second one.
 *
 * Preference order among a task's alive sessions:
 *   1. `<taskId>::tab-1` — the deterministic engine tab. This alone is
 *      enough (the TUI never puts a shell there), so delivery needs no
 *      extra state from the API.
 *   2. a session whose `command[0]` matches `engineBin` (the vendor's own
 *      launch binary) — covers a reattached/renumbered engine. Skips bare
 *      shell tabs (`tab-2`+), which must never receive a prompt.
 *
 * `engineBin` is vendor-neutral: the caller passes
 * `interactiveEngineCommand(vendor)[0]` (or `undefined` when the vendor is
 * unknown, e.g. teardown/liveness — then only rule 1 applies).
 */
export function findEngineKey(sessions: readonly PtySessionInfo[], taskId: string, engineBin?: string): string | null {
  const mine = sessions.filter((s) => s.alive && isTaskKey(s.key, taskId))
  const tab1 = mine.find((s) => s.key === `${taskId}::tab-1`)
  if (tab1) return tab1.key
  if (engineBin) {
    const byCommand = mine.find((s) => s.command[0] === engineBin)
    if (byCommand) return byCommand.key
  }
  return null
}

/** All alive session keys for `taskId` — every tab, for teardown. */
export function taskKeys(sessions: readonly PtySessionInfo[], taskId: string): string[] {
  return sessions.filter((s) => isTaskKey(s.key, taskId)).map((s) => s.key)
}

/** Open a short-lived client without starting the host (read/teardown probes). */
export async function openPtyHost(): Promise<{ rpc: PtyHostRpc; close: () => void } | null> {
  const client = new KobeDaemonClient(defaultPtyHostSocketPath())
  try {
    await client.connect()
  } catch {
    client.close()
    return null
  }
  return { rpc: client, close: () => client.close() }
}

/** Ensure the standalone host exists, then open a short-lived RPC client. */
export async function ensurePtyHost(): Promise<{ rpc: PtyHostRpc; close: () => void }> {
  const socketPath = await ensurePtyHostReachable()
  const client = new KobeDaemonClient(socketPath)
  try {
    await client.connect()
  } catch (error) {
    client.close()
    throw error
  }
  return { rpc: client, close: () => client.close() }
}

/** Session inventory from the pty host; `[]` on any RPC hiccup. */
export async function listSessions(rpc: PtyHostRpc): Promise<PtySessionInfo[]> {
  try {
    const { sessions } = await rpc.request<{ sessions: PtySessionInfo[] }>("pty.list", {})
    return sessions ?? []
  } catch {
    return []
  }
}

/**
 * Deliver `prompt` into an existing hosted engine session and submit it.
 * `pty.open` REATTACHES (spec ignored for a live key — never spawns), then
 * we write the bracketed prompt, wait, and write the CR — the pty twin of
 * `pasteAndSubmit`'s bracketed+deferred-Enter. Returns whether the session
 * was alive to receive it.
 */
export async function deliverToKey(rpc: PtyHostRpc, key: string, cwd: string, prompt: string): Promise<boolean> {
  const open = await rpc.request<PtyOpenResult>("pty.open", { key, cwd, cols: 80, rows: 24 })
  if (!open.alive) return false
  await writePrompt(rpc, key, prompt)
  return true
}

async function writePrompt(rpc: PtyHostRpc, key: string, prompt: string): Promise<void> {
  await rpc.request("pty.write", { key, data: `\x1b[200~${prompt}\x1b[201~` })
  await sleep(SUBMIT_DELAY_MS)
  await rpc.request("pty.write", { key, data: "\r" })
}

/**
 * Deliver to an existing canonical hosted engine, or create it once with
 * the explicit prompt already embedded in its launch argv. The latter avoids
 * racing a paste against a cold engine's startup screen.
 */
export async function deliverHostedPrompt(
  rpc: PtyHostRpc,
  target: { readonly id: string; readonly engineBin?: string },
  cwd: string,
  prompt: string,
  launch: EngineSessionLaunch,
): Promise<DeliveredPrompt> {
  const { sessions = [] } = await rpc.request<{ sessions?: PtySessionInfo[] }>("pty.list", {})
  const existingKey = findEngineKey(sessions, target.id, target.engineBin)
  if (existingKey) {
    try {
      const delivered = await deliverToKey(rpc, existingKey, cwd, prompt)
      return {
        session: existingKey,
        pane: existingKey,
        started: false,
        engineReady: delivered,
        delivered,
      }
    } finally {
      await rpc.request("pty.detach", { key: existingKey }).catch(() => {})
    }
  }

  const staleCanonical = sessions.find((session) => session.key === launch.key && !session.alive)
  if (staleCanonical) await rpc.request("pty.kill", { key: launch.key })

  const open = await rpc.request<PtyOpenResult>("pty.open", {
    key: launch.key,
    cwd,
    command: launch.command,
    cols: 80,
    rows: 24,
  })
  try {
    if (!open.alive) {
      return {
        session: launch.key,
        pane: launch.key,
        started: open.created !== false,
        engineReady: false,
        delivered: false,
      }
    }
    // Another API process may win the create race after our pty.list. Its
    // launch spec wins, so ours did not carry this prompt; deliver it now.
    if (open.created === false) await writePrompt(rpc, launch.key, prompt)
    const delivered = true
    return {
      session: launch.key,
      pane: launch.key,
      started: open.created !== false,
      engineReady: delivered,
      delivered,
    }
  } finally {
    await rpc.request("pty.detach", { key: launch.key }).catch(() => {})
  }
}

/** Kill every hosted session for a task (its engine + any tabs). */
export async function killTaskSessions(rpc: PtyHostRpc, keys: readonly string[]): Promise<void> {
  for (const key of keys) await rpc.request("pty.kill", { key }).catch(() => {})
}
