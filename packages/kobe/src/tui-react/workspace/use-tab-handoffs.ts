/**
 * Mount-once parent-handoff effects extracted from `TerminalTabs.tsx` (the
 * ~500-line cap), sibling of `use-tab-lifecycle.ts`: the imperative
 * editor-tab / engine-send handles handed to the parent. Both are
 * mount-only, forever-lived effects — everything they read comes through
 * the caller's `stateRef`/`propsRef` latest-render mirrors, and every write
 * goes through the caller's `update` (which refreshes `stateRef`
 * synchronously). See the TerminalTabs file header for why refs.
 */

import { useEffect } from "react"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import {
  type EngineTab,
  type TabSpawn,
  type TabsState,
  findEditorTab,
  openEditorTab,
  tabPtyKey,
} from "../../tui/workspace/terminal-tabs-core"
import { releaseSplitLeaves } from "./TerminalSplit"

export interface TabHandoffIO {
  readonly stateRef: { readonly current: TabsState }
  readonly propsRef: {
    readonly current: {
      readonly taskId: string
      readonly worktree: string
      readonly onEditorTabReady?: (open: (command: readonly string[], label: string) => void) => void
      readonly onEngineSendReady?: (send: (text: string) => void) => void
    }
  }
  readonly update: (next: TabsState) => void
  /** Latest-render mirror of the per-tab spawn-opts builder. */
  readonly engineTabSpawnRef: { readonly current: (tab: EngineTab) => TabSpawn }
  readonly bumpResetToken: () => void
}

/**
 * Hand the parent the editor-tab / engine-send imperative handles once per
 * mount — remounting on task/worktree switch re-fires it.
 */
export function useTabHandoffs(io: TabHandoffIO): void {
  const { stateRef, propsRef, update, engineTabSpawnRef } = io

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once handoff; the callback reads propsRef/stateRef for freshness.
  useEffect(() => {
    propsRef.current.onEditorTabReady?.((command, label) => {
      const current = stateRef.current
      const existing = findEditorTab(current)
      if (existing) {
        const key = tabPtyKey(propsRef.current.taskId, existing.id)
        releaseSplitLeaves(key, existing.splitTree ?? null)
        getDefaultPtyRegistry().release(key)
      }
      update(openEditorTab(current, command, label))
      if (existing?.id === current.activeId) io.bumpResetToken()
    })
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once handoff; the callback reads propsRef/stateRef for freshness.
  useEffect(() => {
    propsRef.current.onEngineSendReady?.((text) => {
      // Active tab when it's an engine; else the first engine tab.
      const activeTab = stateRef.current.tabs.find((tab) => tab.id === stateRef.current.activeId)
      const target = activeTab?.kind === "engine" ? activeTab : stateRef.current.tabs.find((t) => t.kind === "engine")
      if (!target) return
      const reg = getDefaultPtyRegistry()
      const key = tabPtyKey(propsRef.current.taskId, target.id)
      let pty = reg.get(key)
      if (!pty && target.kind === "engine") {
        // Parked background tab (issue #28): the host still runs the
        // session — re-acquire reattaches + replays, then the paste lands.
        // Default geometry until the tab is next mounted; the engine
        // rewraps on the real resize like any terminal.
        try {
          pty = reg.acquire(key, propsRef.current.worktree, { ...engineTabSpawnRef.current(target) })
        } catch {
          return
        }
      }
      if (!pty || pty.killed) return
      pty.paste(text)
      pty.write("\r")
    })
  }, [])
}
