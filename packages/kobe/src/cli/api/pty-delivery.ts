/**
 * Hosted-backend (pty-host) side of `kobe api` prompt delivery — the twin
 * of the tmux path in `prompt-delivery.ts`.
 *
 * A task's engine runs in ONE of two backends: the legacy tmux session, or
 * (default) a daemon-hosted PTY owned by the standalone `kobe pty-host`
 * process. `runtime.ts`'s three seams (`isTaskRunning` / `deliverPrompt` /
 * `tearDownSession`) probe hosted FIRST and fall back to tmux, so a
 * pty-host task is addressed on its own backend instead of being mistaken
 * for "not running" — which would silently spawn a SECOND tmux engine in
 * the same worktree and let two agents clobber each other's files.
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
import { defaultPtyHostSocketPath } from "@sma1lboy/kobe-daemon/daemon/paths"
import type { PtyOpenResult } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { PtySessionInfo } from "@sma1lboy/kobe-daemon/daemon/pty-host"

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

/** Open a short-lived pty-host client; resolves `null` when no host is
 *  running (nothing hosted, so the caller falls back to tmux). */
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
  await rpc.request("pty.write", { key, data: `\x1b[200~${prompt}\x1b[201~` })
  await sleep(SUBMIT_DELAY_MS)
  await rpc.request("pty.write", { key, data: "\r" })
  return true
}

/** Kill every hosted session for a task (its engine + any tabs). */
export async function killTaskSessions(rpc: PtyHostRpc, keys: readonly string[]): Promise<void> {
  for (const key of keys) await rpc.request("pty.kill", { key }).catch(() => {})
}
