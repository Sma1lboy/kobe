/**
 * `kobe api inspect` — one production-diagnostics read that aggregates every
 * identity/activity signal a bug report usually needs, so an investigating
 * agent (or Jackson pasting output into a chat) doesn't hand-assemble it
 * from `ps`, state.json, and daemon internals:
 *
 *   - `daemon`    — the daemon's RAW activity registry (`debug.inspect`):
 *                   per-task/per-tab state, probe vendor, armed watchdogs.
 *   - `sessions`  — pty-host inventory (key, pid, live OSC title) JOINED with
 *                   a live process-tree walk per session: which engine is
 *                   ACTUALLY running under each shell right now — the exact
 *                   `foregroundEngineIn` the TUI's live-engine store runs,
 *                   so CLI output and TUI behavior can be compared 1:1.
 *   - `tabs`      — the persisted `terminalTabs.<taskId>` snapshots the
 *                   sidebar tree renders from (liveVendor, lastTitle,
 *                   autoTitle per tab).
 *
 * Read-only by contract: no writes, no spawns, no daemon startup (offline
 * verb — a missing daemon/host degrades that section to null, never errors).
 * `--task-id` narrows every section to one task.
 */

import { foregroundEngineIn, parsePsSnapshot, psSnapshot } from "../../engine/foreground.ts"
import { loadStateFile } from "../../state/store.ts"
import { terminalTabsKey } from "../../tui-react/workspace/terminal-tabs-persist.ts"
import type { TabsState } from "../../tui/workspace/terminal-tabs-core.ts"
import { F } from "./flags.ts"
import type { VerbContext, VerbSpec } from "./types.ts"

type PtySessionRow = {
  key: string
  alive?: boolean
  pid?: number | null
  title?: string
  command?: readonly string[]
  exit?: { code: number | null; signal: string | null; at: string } | null
}

/**
 * Best-effort daemon read — null section when no daemon runs. `inspect` is
 * an offline verb ON PURPOSE (a diagnostics read must never spawn the very
 * daemon it's inspecting), so it connects non-spawning itself instead of
 * taking the dispatcher's auto-start session.
 */
async function daemonSection(): Promise<unknown> {
  const { connectIfRunning } = await import("@sma1lboy/kobe-daemon/client/daemon-process")
  let client: Awaited<ReturnType<typeof connectIfRunning>> = null
  try {
    client = await connectIfRunning()
    if (!client) return null
    // biome-ignore lint/suspicious/noExplicitAny: one generic protocol call site, same as simpleRpc.
    return await client.request("debug.inspect" as any, {})
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    client?.close()
  }
}

/** pty.list + a foreground walk per live session pid. */
async function sessionsSection(taskId: string | undefined): Promise<unknown> {
  const [{ KobeDaemonClient }, { defaultPtyHostSocketPath }] = await Promise.all([
    import("@sma1lboy/kobe-daemon/client"),
    import("@sma1lboy/kobe-daemon/daemon/paths"),
  ])
  const client = new KobeDaemonClient(defaultPtyHostSocketPath())
  let sessions: PtySessionRow[]
  try {
    await client.connect()
    const res = await client.request<{ sessions?: PtySessionRow[] }>("pty.list", {})
    sessions = res.sessions ?? []
  } catch {
    return null // no pty host — an honest "couldn't look", not an empty fleet
  } finally {
    client.close()
  }
  if (taskId) sessions = sessions.filter((s) => s.key.startsWith(taskId))
  // ONE ps snapshot serves every session — same economy as live-engine.ts.
  let rows: ReturnType<typeof parsePsSnapshot> | null = null
  try {
    rows = parsePsSnapshot(await psSnapshot())
  } catch {
    rows = null
  }
  return sessions.map((s) => {
    const walkable = rows !== null && typeof s.pid === "number" && s.pid > 0
    const found = walkable && rows ? foregroundEngineIn(rows, s.pid as number) : null
    return {
      key: s.key,
      alive: s.alive,
      pid: s.pid ?? null,
      title: s.title || null,
      // How a dead session died (host memory) — null while alive/unknown.
      exit: s.exit ?? null,
      // Tri-state, same vocabulary as the TUI store: vendor / null (walked,
      // no engine) / "unknown" (no pid or ps failed — couldn't look).
      foreground: walkable ? (found ? { vendor: found.vendor, pid: found.pid, argv: found.argv } : null) : "unknown",
    }
  })
}

/** Durable death records (`pty-exits.json`) — survive the host's idle-exit,
 *  so "how did it die" stays answerable with no host running. Includes the
 *  exit-time output tail (plain text). */
async function sessionExitsSection(taskId: string | undefined): Promise<unknown> {
  try {
    const { readPtyExitRecords } = await import("@sma1lboy/kobe-daemon/daemon/pty-exit-store")
    const records = Object.values(readPtyExitRecords())
    return taskId ? records.filter((r) => r.key.startsWith(`${taskId}::`)) : records
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Persisted tab snapshots (what the sidebar tree names its rows from). */
function tabsSection(taskId: string | undefined): unknown {
  try {
    const state = loadStateFile()
    const out: Record<string, unknown> = {}
    const prefix = "terminalTabs."
    for (const [key, value] of Object.entries(state)) {
      if (!key.startsWith(prefix)) continue
      const id = key.slice(prefix.length)
      if (taskId && id !== taskId) continue
      const snap = value as TabsState
      if (!snap || !Array.isArray(snap.tabs)) continue
      out[id] = {
        activeId: snap.activeId,
        tabs: snap.tabs.map((t) => ({
          id: t.id,
          kind: t.kind,
          title: t.title ?? null,
          vendor: (t as { vendor?: string }).vendor ?? null,
          liveVendor: t.liveVendor ?? null,
          lastTitle: t.lastTitle ?? null,
          autoTitle: t.autoTitle ?? null,
        })),
      }
    }
    return out
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

async function inspect(ctx: VerbContext): Promise<unknown> {
  const taskId = ctx.args.str("task-id")
  const [daemon, sessions, sessionExits] = await Promise.all([
    daemonSection(),
    sessionsSection(taskId),
    sessionExitsSection(taskId),
  ])
  return { daemon, sessions, sessionExits, tabs: tabsSection(taskId), at: new Date().toISOString() }
}

/** Spec half — spread into {@link VERBS} in `verbs.ts`. */
export const INSPECT_VERB: VerbSpec = {
  name: "inspect",
  summary:
    "Production diagnostics in one read: daemon activity registry (raw states, probe vendors, watchdogs), pty-host sessions joined with a live process-tree engine walk, durable session death records (exit code/signal/output tail), and the persisted tab snapshots the sidebar renders from. Read-only; missing daemon/host degrade to null.",
  flags: [F.taskId(false)],
  offline: true,
  handler: inspect,
}
