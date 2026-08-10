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
 * What (if anything) to run a turn detector against for this tab: whatever
 * engine the live probe sees under the tab's PTY; for a kobe-launched engine
 * tab, the creation pin covers only the window the probe CANNOT answer
 * (PTY not spawned/attached yet — `vendorOf` returns undefined there).
 *
 * `vendorOf` is the tri-state live process identity (`live-engine.ts`, a
 * process-tree walk): a vendor / null ("shell walked, no engine") /
 * undefined ("couldn't look"). The pin used to win unconditionally for
 * engine tabs, which kept a ctrl+C'd codex tab identified as codex forever —
 * wrong detector, wrong persisted identity, wrong sidebar label. A confirmed
 * engine-free shell is a shell, whatever the tab was born as; and an engine
 * tab where the user then typed a DIFFERENT engine tracks that one.
 */
export function targetFor(
  taskId: string,
  tab: TerminalTab,
  taskVendor: VendorId,
  vendorOf: (key: string) => VendorId | null | undefined,
): { vendor: VendorId; key: string } | null {
  const key = soloKey(taskId, tab)
  const pinned = tab.kind === "engine" && hasEngineLeaf(tab.splitTree) ? (tab.vendor ?? taskVendor) : null
  if (!key) {
    // Multi-leaf split: no single process to identify — the engine leaf's
    // pin (if any) still runs the tab-key detector, as before.
    return pinned ? { vendor: pinned, key: tabPtyKey(taskId, tab.id) } : null
  }
  const live = vendorOf(key)
  if (live) return { vendor: live, key }
  // undefined = spawn/attach window → trust the pin; null = confirmed bare
  // shell → no detector, even for an engine-born tab.
  if (live === undefined && pinned) return { vendor: pinned, key }
  return null
}
