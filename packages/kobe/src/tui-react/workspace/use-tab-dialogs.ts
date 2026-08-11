/**
 * Tab-strip dialog flows extracted from `TerminalTabs.tsx` (file-size cap):
 * rename (F2), choose-engine (ctrl+e), quick-fork (ctrl+f). Pure
 * composition over the injected deps — every closure reads the CURRENT
 * render's `state`/`active` (the caller re-creates this hook's return every
 * render, same freshness contract as the inline originals).
 */

import { availableEngineIds } from "@/engine/account-detect"
import { resolveMainRepoRoot } from "@/state/repos"
import { setRepoLastActiveVendor } from "@/state/vendor-prefs"
import type { VendorId } from "@/types/vendor"
import { defaultDaemonSocketPath } from "@sma1lboy/kobe-daemon/daemon/paths"
import { type PaneLaunch, listPaneLaunches } from "@sma1lboy/kobe-daemon/plugins/pane-command"
import { defaultShell } from "../../tui/panes/terminal/pty-types"
import { openPluginPane } from "../../tui/workspace/pane-split"
import {
  type TabsState,
  type TerminalTab,
  addTab,
  openCommandTab,
  renameActiveTab,
} from "../../tui/workspace/terminal-tabs-core"
import { EnginePickerDialog } from "../component/engine-picker-dialog"
import { QuickTaskComposer, type QuickTaskResult } from "../component/quick-task-composer"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import type { useDialog } from "../ui/dialog"
import { addForkTab, addHandoffTab, planChatContinuation } from "./fork-chat-tab"
import { quickForkComposerOptions, quickForkDefaultVendor } from "./quick-fork"
import { tabTitle } from "./tab-strip"

export function useTabDialogs(deps: {
  dialog: ReturnType<typeof useDialog>
  t: (key: string, params?: Record<string, string>) => string
  state: TabsState
  active: TerminalTab
  vendor: VendorId
  worktree: string
  liveTitles: ReadonlyMap<string, string>
  update: (next: TabsState) => void
  pinSession: (s: TabsState, vendor: VendorId | undefined) => TabsState
  /** Active leaf's emulator cells for split-core's size gate (null = unknown). */
  activeLeafSize: () => { cols: number; rows: number } | null
  onChooseEngine?: (vendor: VendorId) => void
  onQuickFork?: (repo: string, result: QuickTaskResult) => void
  /** Toast for the two "nothing to continue from" refusals. */
  notifyError: (title: string) => void
}): {
  requestRename: () => void
  requestChooseEngine: () => void
  requestChatFork: () => void
  requestQuickFork: () => void
} {
  const { dialog, t, state, active, update, pinSession } = deps

  const requestRename = (): void => {
    if (!active) return
    void RenameTaskDialog.show(dialog, tabTitle(active, deps.vendor, deps.liveTitles.get(active.id)), {
      dialogTitle: t("terminal.tab.renameTitle"),
      fieldLabel: t("terminal.tab.renameField"),
      submitLabel: t("terminal.tab.renameSubmit"),
      allowEmpty: true,
    }).then((title) => {
      if (title === undefined) return
      update(renameActiveTab(state, title))
    })
  }

  const requestChooseEngine = (): void => {
    void (async () => {
      const available = await availableEngineIds()
      // Installed plugin panes ride the same picker (owner ask 2026-07-29):
      // ctrl+e is "what runs in this tab", and a pane is exactly that. Reads
      // the local registry synchronously — a handful of small files.
      let panes: PaneLaunch[] = []
      try {
        panes = listPaneLaunches({ socketPath: defaultDaemonSocketPath(), binPath: "kobe" })
      } catch {
        /* registry unreadable → engines only */
      }
      const picked = await EnginePickerDialog.show(dialog, available, deps.vendor, {
        allowShell: true,
        extraChoices: panes.map((p) => ({ key: `pane:${p.pluginId}.${p.paneId}`, label: p.title })),
      })
      if (picked === undefined) return
      const pane = panes.find((p) => `pane:${p.pluginId}.${p.paneId}` === picked)
      if (pane) {
        update(openPluginPane(state, pane.argv, pane.title, pane.placement, undefined, deps.activeLeafSize()))
        return
      }
      // "shell" = a plain terminal tab (kind "command"): no session pin, no
      // vendor preference write, closes itself on exit. Null label so the
      // tab is named by its live foreground process ("zsh", "vim"…).
      if (picked === "shell") {
        update(openCommandTab(state, [defaultShell()], null))
        return
      }
      update(pinSession(addTab(state, picked as VendorId), picked as VendorId))
      deps.onChooseEngine?.(picked as VendorId)
      try {
        setRepoLastActiveVendor(resolveMainRepoRoot(deps.worktree), picked as VendorId)
      } catch {
        /* best-effort: a stale worktree path must not block the new tab */
      }
    })()
  }

  /** `chat.tab.fork` (prefix + `c`): continue THIS conversation in a new tab
   *  of the same worktree. The engine picker decides which of the two shapes
   *  runs — same engine = a native fork, a different one = a handoff briefed
   *  with the old transcript's path (see `fork-chat-tab.ts`). */
  const requestChatFork = (): void => {
    void (async () => {
      const source = (active.kind === "engine" ? active.vendor : undefined) ?? deps.vendor
      const available = await availableEngineIds()
      const target = await EnginePickerDialog.show(dialog, available, source)
      if (target === undefined) return
      const plan = await planChatContinuation(active, source, target as VendorId, deps.worktree)
      if (plan.kind === "fork") {
        update(pinSession(addForkTab(deps.state, target as VendorId, plan.sessionId), target as VendorId))
        return
      }
      if (plan.kind === "handoff") {
        update(pinSession(addHandoffTab(deps.state, target as VendorId, plan.prompt), target as VendorId))
        return
      }
      deps.notifyError(
        plan.kind === "no-transcript"
          ? t("terminal.tab.noTranscriptToHandOff", { engine: plan.engine })
          : t("terminal.tab.nothingToFork"),
      )
    })()
  }

  /** Quick-fork (issue #17, ctrl+f): open the same composer `<prefix> f`
   *  uses, seeded from THIS task's repo/branch/engine. Repo is fixed (not
   *  editable here — same constraint quick-task/host.tsx documents); the
   *  parent creates the child task on submit. */
  const requestQuickFork = (): void => {
    void (async () => {
      let repo: string
      try {
        repo = resolveMainRepoRoot(deps.worktree)
      } catch {
        return
      }
      const detected = await availableEngineIds()
      // Default engine = the one THIS task runs ("fork me as I am"); the
      // composer's engine field still switches it to any other detected one.
      const defaultVendor = detected.includes(deps.vendor) ? deps.vendor : quickForkDefaultVendor(repo, detected)
      const engines = detected.length > 0 ? detected : [defaultVendor]
      const result = await QuickTaskComposer.show(
        dialog,
        quickForkComposerOptions(repo, engines, defaultVendor, deps.worktree),
      )
      if (result === undefined) return
      deps.onQuickFork?.(repo, result)
    })()
  }

  return { requestRename, requestChooseEngine, requestChatFork, requestQuickFork }
}
