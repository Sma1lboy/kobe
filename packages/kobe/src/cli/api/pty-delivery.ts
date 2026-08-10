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

import type { PtyOpenResult } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { PtySessionInfo } from "@sma1lboy/kobe-daemon/daemon/pty-host"
import { type PsSnapshot, engineProcessIn, parsePsSnapshot, psSnapshot } from "../../engine/foreground.ts"
import {
  type HostedSessionRpc,
  deliverToHostedKey,
  ensureHostedSessionHost,
  findHostedEngineKey,
  hostedTaskKeys,
  isHostedTaskKey,
  killHostedSessions,
  listHostedSessions,
  openHostedSessionHost,
  writeHostedPrompt,
} from "../../engine/hosted-session.ts"
import type { EngineSessionLaunch } from "../../engine/session-launch.ts"
import { ApiError, type DeliveredPrompt } from "./types.ts"

/**
 * Foreground gate for delivery into an EXISTING session (herdr's
 * "agent is no longer the pane foreground process" check, ported to the
 * process tree): a session's spawn argv says what WAS launched, not what is
 * running now — kobe's keepAlive drops an exited engine into a fallback
 * SHELL, where a pasted prompt executes as shell commands. Walk the PTY
 * child's descendants: any registered engine counts (cross-vendor send is
 * legitimate), `extraBin` additionally matches a custom engine's binary
 * name. False on no pid / ps failure — unverifiable is "not an engine".
 *
 * Known ceiling: during an engine's first ~1-2s (login shell still sourcing
 * rc, engine child not yet spawned) the gate reads "shell only" and refuses;
 * the typed error's hint makes the retry trivial. Watching the spawn argv
 * would close it but can't distinguish boot from the post-exit exec'd shell.
 */
async function sessionHasEngine(
  pid: number | null | undefined,
  extraBin?: string,
  snapshot: PsSnapshot = psSnapshot,
): Promise<boolean> {
  if (!pid) return false
  try {
    return engineProcessIn(parsePsSnapshot(await snapshot()), pid, extraBin)
  } catch {
    return false
  }
}

/**
 * The narrow pty-host surface this module needs: request/response RPC plus
 * cleanup. `KobeDaemonClient` satisfies it; tests inject a fake that
 * records requests instead of opening a socket.
 */
export type PtyHostRpc = HostedSessionRpc

/**
 * A key belongs to `taskId` when its segment before the first `::` matches
 * — the same split `pty-host.ts` `sweepTasks` uses. `tab-1` is the engine
 * tab the TUI's `initialTabs()` always mints first.
 */
export const isTaskKey = isHostedTaskKey

/**
 * Pick the ALIVE engine session key for `taskId`, or `null` when none —
 * the single source of truth both delivery and liveness route through, so
 * "no engine" NEVER falls through to spawning a second one.
 *
 * `engineBin` is vendor-neutral: the caller passes
 * `interactiveEngineCommand(vendor)[0]` (or `undefined` when the vendor is
 * unknown, e.g. teardown/liveness — then only the `tab-1` rule applies).
 * Shared with the daemon's quota-resume path — see `hosted-session.ts`.
 */
export const findEngineKey = findHostedEngineKey

/** All alive session keys for `taskId` — every tab, for teardown. */
export const taskKeys = hostedTaskKeys

/** Open a short-lived client without starting the host (read/teardown probes). */
export const openPtyHost = openHostedSessionHost

/** Ensure the standalone host exists, then open a short-lived RPC client. */
export const ensurePtyHost = ensureHostedSessionHost

/** Session inventory from the pty host; `[]` on any RPC hiccup. */
export const listSessions = listHostedSessions

/**
 * Deliver `prompt` into an existing hosted engine session and submit it —
 * the bracketed+deferred-Enter pty twin of `pasteAndSubmit`, shared with the
 * daemon's quota-resume path (see `hosted-session.ts`). Returns whether the
 * session was alive to receive it.
 */
export const deliverToKey = deliverToHostedKey

const writePrompt = writeHostedPrompt

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
  opts?: { readonly forceNew?: boolean; readonly snapshot?: PsSnapshot },
): Promise<DeliveredPrompt> {
  const { sessions = [] } = await rpc.request<{ sessions?: PtySessionInfo[] }>("pty.list", {})
  // `forceNew` (send --tab new): the caller minted a fresh tab key and wants
  // a NEW engine spawned there — never reroute into the existing canonical
  // engine, which is exactly what the lookup below would do.
  const existingKey = opts?.forceNew ? null : findEngineKey(sessions, target.id, target.engineBin)
  if (existingKey) {
    // Foreground gate: the session's SPAWN argv matched an engine, but the
    // engine may have exited into the keepAlive shell since — pasting there
    // executes the prompt as shell commands. See {@link sessionHasEngine}.
    const pid = sessions.find((s) => s.key === existingKey)?.pid
    if (!(await sessionHasEngine(pid, target.engineBin, opts?.snapshot))) {
      throw new ApiError(
        `task ${target.id}'s engine tab (${existingKey}) has no live engine process — its engine exited into a plain shell`,
        "ENGINE_NOT_RUNNING",
        {
          hint: "spawn a fresh engine tab for this prompt with --tab new",
          nextCommandArgs: ["api", "send", "--task-id", target.id, "--tab", "new", "--prompt", prompt],
        },
      )
    }
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

/**
 * Deliver into ONE exact tab (`send --tab tab-N`) — no fallback, no spawn.
 * The addressed tab must exist and be alive; anything else is a typed error
 * so a script targeting "the second tab" never silently lands in the first.
 */
export async function deliverToExactTab(
  rpc: PtyHostRpc,
  taskId: string,
  tabId: string,
  cwd: string,
  prompt: string,
  opts?: { readonly engineBin?: string; readonly snapshot?: PsSnapshot },
): Promise<DeliveredPrompt> {
  const key = `${taskId}::${tabId}`
  const { sessions = [] } = await rpc.request<{ sessions?: PtySessionInfo[] }>("pty.list", {})
  const session = sessions.find((s) => s.key === key)
  if (!session?.alive) {
    throw new ApiError(
      `tab ${tabId} has no live session on task ${taskId} — see \`kobe api pty-list\` for alive tabs`,
      "TAB_NOT_FOUND",
    )
  }
  // Same foreground gate as the canonical path: an addressed tab whose
  // engine exited (or that always was a shell tab) must not have the prompt
  // pasted into its shell. ANY running engine passes — the addressed tab's
  // engine need not match the task's vendor (cross-vendor send).
  if (!(await sessionHasEngine(session.pid, opts?.engineBin, opts?.snapshot))) {
    throw new ApiError(
      `tab ${tabId} on task ${taskId} has no live engine process — it is a plain shell right now`,
      "ENGINE_NOT_RUNNING",
      {
        hint: "spawn a fresh engine tab for this prompt with --tab new, or pick an engine tab from pty-list",
        nextCommandArgs: ["api", "pty-list"],
      },
    )
  }
  try {
    const delivered = await deliverToKey(rpc, key, cwd, prompt)
    return { session: key, pane: key, started: false, engineReady: delivered, delivered }
  } finally {
    await rpc.request("pty.detach", { key }).catch(() => {})
  }
}

/** Kill every hosted session for a task (its engine + any tabs). */
export const killTaskSessions = killHostedSessions
