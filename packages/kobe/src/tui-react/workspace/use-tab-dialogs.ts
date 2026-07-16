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
import { defaultShell } from "../../tui/panes/terminal/pty-types"
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
import { quickForkComposerOptions, quickForkDefaultVendor } from "./quick-fork"
import { tabTitle } from "./tab-strip"

export function useTabDialogs(deps: {
  dialog: ReturnType<typeof useDialog>
  t: (key: string) => string
  state: TabsState
  active: TerminalTab
  vendor: VendorId
  worktree: string
  liveTitles: ReadonlyMap<string, string>
  update: (next: TabsState) => void
  pinSession: (s: TabsState, vendor: VendorId | undefined) => TabsState
  onChooseEngine?: (vendor: VendorId) => void
  onQuickFork?: (repo: string, result: QuickTaskResult) => void
}): {
  requestRename: () => void
  requestChooseEngine: () => void
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
      const picked = await EnginePickerDialog.show(dialog, available, deps.vendor, { allowShell: true })
      if (picked === undefined) return
      // "shell" = a plain terminal tab (kind "command"): no session pin, no
      // vendor preference write, closes itself on exit. Null label so the
      // tab is named by its live foreground process ("zsh", "vim"…).
      if (picked === "shell") {
        update(openCommandTab(state, [defaultShell()], null))
        return
      }
      update(pinSession(addTab(state, picked), picked))
      deps.onChooseEngine?.(picked)
      try {
        setRepoLastActiveVendor(resolveMainRepoRoot(deps.worktree), picked)
      } catch {
        /* best-effort: a stale worktree path must not block the new tab */
      }
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
      const defaultVendor = quickForkDefaultVendor(repo, detected)
      const engines = detected.length > 0 ? detected : [defaultVendor]
      const result = await QuickTaskComposer.show(dialog, quickForkComposerOptions(repo, engines, defaultVendor))
      if (result === undefined) return
      deps.onQuickFork?.(repo, result)
    })()
  }

  return { requestRename, requestChooseEngine, requestQuickFork }
}
