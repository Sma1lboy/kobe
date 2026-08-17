/**
 * Fold a scratch shell into the task that already owns its cwd (issue #40)
 * — the execution half of `decideScratchAdopt`'s `fold` verdict. Instead of
 * repointing the scratch row at the repo (which minted a duplicate sidebar
 * row for a directory some task already names), the shell's HOSTED sessions
 * are re-keyed under the owning task's next free tab ids (`pty.rename` — the
 * child keeps running, engine and all) and the tab records are adopted
 * through the ordinary orphan-adoption write (`adoptTaskTabs`), which never
 * steals the target's active tab. The caller then deletes the emptied
 * scratch row.
 *
 * Hosted backend only: a local (`Bun.spawn`) shell lives inside this
 * process keyed to the scratch task and cannot change owners host-side —
 * `rename` answers false and the shell simply STAYS in Scratch (quiet,
 * retried each tick), which beats minting the duplicate row this fixes.
 */

import { getSharedPtyClient } from "../../tui/panes/terminal/pty-hosted-client"
import { tabPtyKey } from "../../tui/workspace/terminal-tabs-core"
import { adoptTaskTabs } from "./terminal-tabs-adopt"
import type { TabsSnapshotKv } from "./terminal-tabs-persist"
import { knownTaskTabs } from "./terminal-tabs-shared"

export interface ScratchFoldIO {
  readonly kv: TabsSnapshotKv
  /** Host-side session re-key (`pty.rename`); false = source session gone,
   *  target key taken, or a host that predates the verb. Injectable for
   *  tests; defaults to the shared pty-host client. */
  readonly rename?: (from: string, to: string) => Promise<boolean>
}

async function renameHostedSession(from: string, to: string): Promise<boolean> {
  if ((process.env.KOBE_TERMINAL_BACKEND ?? "hosted") !== "hosted") return false
  try {
    const client = await getSharedPtyClient()
    const res = await client.request<{ renamed?: boolean }>("pty.rename", { from, to })
    return res.renamed === true
  } catch {
    return false
  }
}

const tabNumber = (id: string): number => Number(/^tab-(\d+)$/.exec(id)?.[1] ?? 0)

/**
 * Move every hosted session of `scratchTaskId`'s tabs under
 * `targetTaskId`'s next free tab ids and adopt them into its tab state.
 * Returns the folded id of the scratch's FIRST tab (the shell — the one the
 * user was watching, for selection follow-up), or null when nothing moved
 * (no hosted sessions / old host) — the scratch row must then stay put.
 */
export async function foldScratchShell(
  io: ScratchFoldIO,
  scratchTaskId: string,
  targetTaskId: string,
): Promise<{ activeTabId: string } | null> {
  const rename = io.rename ?? renameHostedSession
  // The scratch shell is tab-1 by construction; extra tabs the user opened
  // in the scratch task ride along under their own new ids.
  const scratchTabIds = (knownTaskTabs(io.kv, scratchTaskId)?.tabs ?? [{ id: "tab-1" }]).map((tab) => tab.id)
  let next =
    1 + (knownTaskTabs(io.kv, targetTaskId)?.tabs ?? []).reduce((max, tab) => Math.max(max, tabNumber(tab.id)), 0)
  const folded: string[] = []
  for (const tabId of scratchTabIds) {
    const from = tabPtyKey(scratchTaskId, tabId)
    // One bump retry: a stray hosted session (an orphan the sidebar hasn't
    // adopted yet) can occupy the computed id.
    let ok = await rename(from, tabPtyKey(targetTaskId, `tab-${next}`))
    if (!ok) {
      next++
      ok = await rename(from, tabPtyKey(targetTaskId, `tab-${next}`))
    }
    if (!ok) continue
    folded.push(`tab-${next}`)
    next++
    // The local handle still keyed to `from` is NOT released here: the
    // scratch row's deletion (the caller's next step) runs the ordinary
    // task-PTY sweep, whose `pty.kill` on the old key is a host-side no-op
    // after the rename — the moved session survives, the handle dies.
  }
  if (folded.length === 0) return null
  adoptTaskTabs(io.kv, targetTaskId, folded)
  return { activeTabId: folded[0] as string }
}
