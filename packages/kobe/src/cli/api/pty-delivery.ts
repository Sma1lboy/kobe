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
  pastePromptWhenEngineUp,
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
 * Deliver to an existing hosted engine tab, or — ONLY when the task has no
 * alive session at all — create the canonical one with the explicit prompt
 * already embedded in its launch argv (avoids racing a paste against a cold
 * engine's startup screen). `started: true` in the result means "a NEW
 * session was created", never "delivered into an existing one".
 *
 * When alive tabs exist but none resolves as an engine, this THROWS
 * (NO_ENGINE_TAB) instead of spawning. Issue #19: the silent-spawn fallback
 * booted an unsandboxed `--dangerously-skip-permissions` engine (in the
 * incident, cwd'd at the MAIN repo) while both sender and receiver believed
 * the message was delivered. A well-meaning fallback here is
 * indistinguishable from success on both sides — it must stay loud.
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
    // No pty.detach: delivery peeks + writes without ever attaching, and a
    // detach from a never-attached client would clear a parked TUI's
    // exact-delta restore state as a side effect.
    const delivered = await deliverToKey(rpc, existingKey, prompt)
    return {
      session: existingKey,
      pane: existingKey,
      started: false,
      engineReady: delivered,
      delivered,
    }
  }

  // No engine resolved. Spawning is legitimate ONLY when the task has no
  // alive session whatsoever (first start / all-dead resume) — an alive tab
  // we merely failed to identify means the prompt would land in a duplicate
  // engine the receiver never sees. Fail loud; the caller picks a tab.
  if (!opts?.forceNew) {
    const aliveTabs = sessions.filter((s) => s.alive && isTaskKey(s.key, target.id)).map((s) => s.key)
    if (aliveTabs.length > 0) {
      throw new ApiError(
        `task ${target.id} has live tabs (${aliveTabs.join(", ")}) but none resolves as its engine tab — refusing to spawn a new engine`,
        "NO_ENGINE_TAB",
        {
          hint: "address a live engine tab explicitly with --tab <tab-N> (see pty-list), or spawn a fresh engine tab with --tab new",
          nextCommandArgs: ["api", "pty-list"],
        },
      )
    }
  }

  const staleCanonical = sessions.find((session) => session.key === launch.key && !session.alive)
  // A FREEZE-RESTORED corpse is not killed: `pty.open` respawns it in place
  // (pre-restart scrollback kept), so the launch below both revives the tab
  // and carries this prompt. An ordinary corpse (died while the host lived)
  // is view-only — open would ignore our spec, so it must be killed first.
  if (staleCanonical && staleCanonical.restored !== true) await rpc.request("pty.kill", { key: launch.key })

  // No cols/rows: the host sizes the fresh spawn itself (80×24 default);
  // on the lost-create-race reattach below, a size-less open never resizes
  // the winner's session away from whatever client is attached to it.
  const open = await rpc.request<PtyOpenResult>("pty.open", {
    key: launch.key,
    cwd,
    command: launch.command,
  })
  try {
    if (!open.alive) {
      return {
        session: launch.key,
        pane: launch.key,
        started: open.created !== false || open.respawned === true,
        engineReady: false,
        delivered: false,
      }
    }
    // Paste-delivery vendor (kimi — issue #25): the launch spawned the bare
    // engine and carried the first message OUTSIDE its argv; paste it once
    // the engine process is up. A paste that never lands is a failed start,
    // not a delivered prompt.
    if (launch.firstMessage) {
      const delivered = await pastePromptWhenEngineUp(rpc, launch.key, target.engineBin, launch.firstMessage)
      return {
        session: launch.key,
        pane: launch.key,
        started: open.created !== false || open.respawned === true,
        engineReady: delivered,
        delivered,
      }
    }
    // Another API process may win the create race after our pty.list. Its
    // launch spec wins, so ours did not carry this prompt; deliver it now.
    // A RESPAWNED restored corpse is the opposite: our launch DID run (the
    // prompt rode its argv), so pasting here would deliver it twice.
    if (open.created === false && open.respawned !== true) await writePrompt(rpc, launch.key, prompt)
    const delivered = true
    return {
      session: launch.key,
      pane: launch.key,
      started: open.created !== false || open.respawned === true,
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
      `tab ${tabId} has no live session on task ${taskId} — see \`rove api pty-list\` for alive tabs`,
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
  // No pty.detach — see deliverHostedPrompt's existing-key path.
  const delivered = await deliverToKey(rpc, key, prompt)
  return { session: key, pane: key, started: false, engineReady: delivered, delivered }
}

/** Kill every hosted session for a task (its engine + any tabs). */
export const killTaskSessions = killHostedSessions
