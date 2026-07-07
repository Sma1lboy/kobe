/**
 * Pure "what should this tab's turn detector track" resolution — extracted
 * out of `turn-polls.ts` (issue #16 React migration) so the Solid poll loop
 * and the React `use-turn-polls.ts` hook share ONE identity rule instead of
 * two hand-kept copies. Framework-free: no signals, no React state, just
 * `TabsState` + a title lookup.
 *
 * Unified process-identity model (owner 2026-07-07): every tab is a shell;
 * an engine is just a process running in it. A tab's turn detector target
 * is either the tab's OWN kobe-launched engine (by construction) or, for
 * any other tab, whatever its solo live PTY's OSC title says is running —
 * see `turn-polls.ts`'s header for the full rationale.
 */

import { vendorFromTerminalTitle } from "@/engine/registry"
import type { VendorId } from "@/types/vendor"
import { leaves } from "./split-core"
import { type TerminalTab, hasEngineLeaf, splitLeafPtyKey, tabPtyKey } from "./terminal-tabs-core"

/**
 * The tab's single live PTY surface: unsplit tabs (and tabs collapsed to
 * one leaf) have exactly one process to identify; a multi-leaf tab has no
 * single "the tab's process", so title identity is undefined (null).
 */
export function soloKey(taskId: string, tab: TerminalTab): string | null {
  const tabKey = tabPtyKey(taskId, tab.id)
  if (!tab.splitTree) return tabKey
  const ls = leaves(tab.splitTree.root)
  return ls.length === 1 ? splitLeafPtyKey(tabKey, ls[0].id) : null
}

/**
 * What (if anything) to run a turn detector against for this tab: a
 * kobe-launched engine → its pinned vendor at the tab key; anything else
 * with a solo PTY whose live title matches an engine → that vendor.
 * `titleOf` reads the caller's own title cache (a Map in both runtimes).
 */
export function targetFor(
  taskId: string,
  tab: TerminalTab,
  taskVendor: VendorId,
  titleOf: (key: string) => string | undefined,
): { vendor: VendorId; key: string } | null {
  if (tab.kind === "engine" && hasEngineLeaf(tab.splitTree)) {
    return { vendor: tab.vendor ?? taskVendor, key: tabPtyKey(taskId, tab.id) }
  }
  const key = soloKey(taskId, tab)
  if (!key) return null
  const vendor = vendorFromTerminalTitle(titleOf(key))
  return vendor ? { vendor, key } : null
}
