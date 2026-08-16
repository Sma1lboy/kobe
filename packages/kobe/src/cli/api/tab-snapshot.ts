/**
 * Publish a tab snapshot for a session the CLI started.
 *
 * The sidebar tree renders a worktree's tabs by reading the task's
 * `terminalTabs.<taskId>` snapshot (see `tui-react/workspace/
 * terminal-tabs-shared.ts`). That snapshot was only ever written by a MOUNTED
 * `TerminalTabs` — so a task started headlessly (`kobe api add --prompt`,
 * `kobe api send`, a routine firing) ran a perfectly live engine that the
 * tree could not see: `knownTaskTabs` returned null and the worktree row got
 * no children at all. Since headless start is how agent-driven work enters
 * kobe, that was most of the fleet rendering as empty worktrees.
 *
 * Same fix the issue-chat background spawn already applies
 * (`tui/workspace/issue-chat-spawn.ts` — "persist so a visit attaches, not
 * respawns"); this is that precedent applied to the CLI's own launch path.
 *
 * Deliberately WRITE-ONCE: it seeds the first engine tab for a task with no
 * snapshot and never touches an existing one. A mounted TUI owns tab state
 * for real (ordinals, titles, splits, closes), and a CLI process must not
 * fight it — `kobe api send` into a task you have open in the TUI reuses that
 * session, so overwriting here would clobber live state with a one-tab stub.
 */

import type { PtySessionExit } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { loadStateFile, patchStateFile } from "../../state/store.ts"
import { terminalTabsKey } from "../../tui-react/workspace/terminal-tabs-persist.ts"
import { type TabsState, type TerminalTab, initialTabs } from "../../tui/workspace/terminal-tabs-core.ts"
import type { VendorId } from "../../types/vendor.ts"

/**
 * One tab row `get-task` returns: the persisted snapshot fields the sidebar
 * renders from (same mapping as `inspect`'s tabs section) joined with whether
 * the tab's OWN hosted session (`<taskId>::<tabId>`) is alive right now — the
 * discovery read an agent needs to pick a `send --tab tab-N` target.
 */
export interface TaskTabRow {
  readonly id: string
  readonly kind: TerminalTab["kind"]
  readonly title: string | null
  readonly vendor: string | null
  readonly liveVendor: string | null
  readonly lastTitle: string | null
  readonly autoTitle: string | null
  readonly alive: boolean
  /** How the tab's session died — ABNORMAL exits only (clean exit 0 stays
   *  null, per issue #9's no-noise rule); null while alive/unknown. Joined
   *  from the live host when present, else the durable exit records. */
  readonly exit: PtySessionExit | null
  /** Present (true) only on rows derived from a LIVE pty session the
   *  persisted snapshot does not list — issue #20's invisible engine. The
   *  snapshot is a record of intent; the pty host holds the truth, and a
   *  divergence must render as a row, not vanish. */
  readonly unregistered?: true
}

/** The slice of a `pty.list` row the liveness joins below need. */
export interface TaskSessionRow {
  readonly key: string
  readonly alive?: boolean
  readonly exit?: PtySessionExit | null
}

/** The task's persisted `terminalTabs.<taskId>` snapshot; undefined when absent/malformed/unreadable. */
export function readTabsSnapshot(taskId: string): TabsState | undefined {
  try {
    const snap = loadStateFile()[terminalTabsKey(taskId)] as TabsState | undefined
    return snap && Array.isArray(snap.tabs) ? snap : undefined
  } catch {
    return undefined
  }
}

const aliveKeysOf = (sessions: readonly TaskSessionRow[]): Set<string> =>
  new Set(sessions.filter((s) => s.alive).map((s) => s.key))

/**
 * Tab ids with a LIVE `<taskId>::<tabId>` pty session the snapshot does not
 * list — the reconciliation read behind issue #20 (a canonical-spawn
 * fallback, an older kobe, any future path that opens a session without
 * writing the snapshot). Split leaves (`::leaf-N` suffix) belong to their
 * tab and never count on their own, matching `joinTaskTabs`' exact-key rule.
 */
export function unregisteredTabIds(
  snapshot: TabsState | undefined,
  taskId: string,
  sessions: readonly TaskSessionRow[],
): string[] {
  const known = new Set((snapshot?.tabs ?? []).map((t) => t.id))
  const prefix = `${taskId}::`
  const out: string[] = []
  for (const s of sessions) {
    if (!s.alive || !s.key.startsWith(prefix)) continue
    const tabId = s.key.slice(prefix.length)
    if (tabId.includes("::")) continue // split leaf — its tab is the row
    if (!known.has(tabId) && !out.includes(tabId)) out.push(tabId)
  }
  return out
}

/** Abnormal death only — exit 0 without a signal is not worth surfacing. */
const abnormalExit = (exit: PtySessionExit | null | undefined): PtySessionExit | null =>
  exit && (exit.code !== 0 || exit.signal !== null) ? exit : null

/**
 * Persisted tabs joined with hosted-session liveness. Exact-key match on
 * purpose: a split's extra shell leaves (`<taskId>::<tabId>::leaf-N`) never
 * make the tab itself read alive — only the tab's own session does.
 * `persistedExits` (the durable `pty-exits.json` records, keyed by session
 * key) answers "how did it die" after the host itself is gone; a live host's
 * in-memory exit wins when both exist.
 *
 * `liveVendors` (issue #33) is a fresh foreground-walk verdict per session
 * key — the same tri-state the TUI's live-engine store speaks: a vendor =
 * that engine runs under the session's shell NOW, null = walked and
 * engine-free, absent = couldn't look. Where it answers it overrides the
 * RECORDED `liveVendor` (a snapshot written only by a mounted TUI, so it
 * goes stale for tasks never opened): a user-typed `claude` in a shell tab
 * reads as live claude, and a ctrl+C'd engine reads as a plain shell. A
 * dead session's verdict is meaningless — only alive rows take it.
 */
export function joinTaskTabs(
  snapshot: TabsState | undefined,
  taskId: string,
  sessions: readonly TaskSessionRow[],
  persistedExits: Readonly<Record<string, PtySessionExit>> = {},
  liveVendors?: ReadonlyMap<string, string | null>,
): TaskTabRow[] {
  const alive = aliveKeysOf(sessions)
  const sessionExits = new Map(sessions.map((s) => [s.key, s.exit]))
  const rows: TaskTabRow[] = (snapshot?.tabs ?? []).map((t) => {
    const key = `${taskId}::${t.id}`
    const isAlive = alive.has(key)
    const walked = isAlive && liveVendors?.has(key) === true ? (liveVendors.get(key) ?? null) : undefined
    return {
      id: t.id,
      kind: t.kind,
      title: t.title ?? null,
      vendor: (t as { vendor?: string }).vendor ?? null,
      liveVendor: walked !== undefined ? walked : (t.liveVendor ?? null),
      lastTitle: t.lastTitle ?? null,
      autoTitle: t.autoTitle ?? null,
      alive: isAlive,
      exit: isAlive ? null : abnormalExit(sessionExits.get(key) ?? persistedExits[key]),
    }
  })
  // Live sessions the snapshot doesn't know still get a row — the discovery
  // read must show every engine that exists, not just the registered ones.
  // "engine" is the same assumption the sidebar's orphan backstop documents:
  // headless paths only ever start engines.
  for (const tabId of unregisteredTabIds(snapshot, taskId, sessions)) {
    rows.push({
      id: tabId,
      kind: "engine",
      title: null,
      vendor: null,
      liveVendor: null,
      lastTitle: null,
      autoTitle: null,
      alive: true,
      exit: null,
      unregistered: true,
    })
  }
  return rows
}

/**
 * A task is RUNNING when ANY of its engine tabs has a live hosted session —
 * not just the canonical first one. The old `tab-1`-only rule reported
 * `running:false` while later engine tabs (`send --tab new`, a TUI tab
 * opened after tab-1 closed) were happily alive. The `tab-1` key stays as a
 * snapshot-free floor: it is always an engine tab by construction
 * (`initialTabs`), so it counts even when the snapshot write failed.
 * Non-engine tabs (command/content) never count — same rule delivery uses.
 */
export function hasLiveEngineTab(
  snapshot: TabsState | undefined,
  taskId: string,
  sessions: readonly TaskSessionRow[],
): boolean {
  const alive = aliveKeysOf(sessions)
  if (alive.has(`${taskId}::tab-1`)) return true
  return (snapshot?.tabs ?? []).some((t) => t.kind === "engine" && alive.has(`${taskId}::${t.id}`))
}

/**
 * Seed `terminalTabs.<taskId>` with the canonical first engine tab when the
 * task has none. No-op when a snapshot already exists, and never throws — a
 * sidebar-visibility nicety must not fail an otherwise-good session start.
 *
 * `sessionId` is the conversation id the launch pinned (`withClaudeSessionId`)
 * — recording it (with `spawned`, the conversation provably started: the
 * caller only passes it after a successful delivery) makes a later
 * dead-reattach `--resume` this conversation, matching a TUI-spawned tab.
 */
export function publishCliTabSnapshot(taskId: string, sessionId?: string | null): void {
  if (!taskId) return
  try {
    const key = terminalTabsKey(taskId)
    if (loadStateFile()[key] !== undefined) return
    // `initialTabs()` is the same shape a mounting TerminalTabs would write:
    // one engine tab `tab-1`, active — matching the PTY key the CLI launch
    // path uses (`engineSessionKey` → `<taskId>::tab-1`), so the tree's row
    // and the live process agree on which tab this is.
    const seeded = initialTabs()
    patchStateFile({
      [key]: sessionId
        ? {
            ...seeded,
            tabs: seeded.tabs.map((t): TerminalTab => (t.kind === "engine" ? { ...t, sessionId, spawned: true } : t)),
          }
        : seeded,
    })
  } catch {
    // Unreadable/unwritable state.json: the session is still fine, the tree
    // just won't list its tab until the TUI opens the task.
  }
}

/**
 * Record a CLI-spawned EXTRA tab's pinned session id after its session
 * actually started (the `send --tab new` twin of {@link publishCliTabSnapshot}'s
 * sessionId). mintCliTab runs BEFORE the spawn — it deliberately leaves the
 * id unset so a failed start never claims a resumable conversation that
 * does not exist (claude errors hard on `--resume` of a missing id).
 */
export function markCliTabSession(taskId: string, tabId: string, sessionId: string): void {
  try {
    const key = terminalTabsKey(taskId)
    const existing = loadStateFile()[key] as TabsState | undefined
    if (!existing || !Array.isArray(existing.tabs)) return
    patchStateFile({
      [key]: {
        ...existing,
        tabs: existing.tabs.map(
          (t): TerminalTab => (t.id === tabId && t.kind === "engine" ? { ...t, sessionId, spawned: true } : t),
        ),
      },
    })
  } catch {
    // Same best-effort contract as the snapshot writers above.
  }
}

/**
 * Mint the next engine-tab id for a CLI-spawned EXTRA tab (`send --tab new`)
 * and append it to the task's persisted snapshot, so a mounted (or later)
 * TUI renders and attaches the tab instead of never knowing it exists.
 *
 * The append mirrors `addTab()`'s shape but keys the id off `nextOrdinal`
 * exactly like the TUI does, so CLI- and TUI-minted ids can never collide —
 * both consume the same monotonic counter from the same snapshot. Unlike
 * {@link publishCliTabSnapshot} this MUST write over an existing snapshot
 * (that's where the counter lives); a task with none gets seeded first.
 *
 * Best-effort like its sibling — but the caller needs the id even when
 * state.json is unwritable, so the id is returned regardless and the
 * snapshot write failure only costs sidebar visibility.
 */
export function mintCliTab(taskId: string, vendor?: VendorId, command?: string): string {
  let tabId = "tab-1"
  try {
    const key = terminalTabsKey(taskId)
    const existing = loadStateFile()[key] as TabsState | undefined
    const state = existing && Array.isArray(existing.tabs) && existing.tabs.length > 0 ? existing : initialTabs()
    const ordinal = typeof state.nextOrdinal === "number" && state.nextOrdinal > 1 ? state.nextOrdinal : 2
    tabId = `tab-${ordinal}`
    patchStateFile({
      [key]: {
        ...state,
        // `command`/`vendor` present = this tab is PINNED to an engine other
        // than the task's default (`send --tab new --command …`); `vendor` is
        // the same field the TUI's ctrl+e pick writes. Absent, the tab
        // follows the task like every other.
        tabs: [
          ...state.tabs,
          {
            kind: "engine",
            id: tabId,
            title: null,
            ordinal,
            ...(vendor ? { vendor } : {}),
            ...(command ? { engineCommand: command } : {}),
          },
        ],
        activeId: tabId,
        nextOrdinal: ordinal + 1,
      },
    })
  } catch {
    // Snapshot write failed: fall back to a time-keyed id that cannot
    // collide with ordinal ids, so the spawn still proceeds.
    tabId = `tab-cli-${Date.now().toString(36)}`
  }
  return tabId
}
