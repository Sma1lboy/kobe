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

import { loadStateFile, patchStateFile } from "../../state/store.ts"
import { terminalTabsKey } from "../../tui-react/workspace/terminal-tabs-persist.ts"
import { type TabsState, initialTabs } from "../../tui/workspace/terminal-tabs-core.ts"

/**
 * Seed `terminalTabs.<taskId>` with the canonical first engine tab when the
 * task has none. No-op when a snapshot already exists, and never throws — a
 * sidebar-visibility nicety must not fail an otherwise-good session start.
 */
export function publishCliTabSnapshot(taskId: string): void {
  if (!taskId) return
  try {
    const key = terminalTabsKey(taskId)
    if (loadStateFile()[key] !== undefined) return
    // `initialTabs()` is the same shape a mounting TerminalTabs would write:
    // one engine tab `tab-1`, active — matching the PTY key the CLI launch
    // path uses (`engineSessionKey` → `<taskId>::tab-1`), so the tree's row
    // and the live process agree on which tab this is.
    patchStateFile({ [key]: initialTabs() })
  } catch {
    // Unreadable/unwritable state.json: the session is still fine, the tree
    // just won't list its tab until the TUI opens the task.
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
export function mintCliTab(taskId: string): string {
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
        tabs: [...state.tabs, { kind: "engine", id: tabId, title: null, ordinal }],
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
