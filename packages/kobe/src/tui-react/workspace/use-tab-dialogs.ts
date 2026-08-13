/**
 * Tab-strip dialog flows extracted from `TerminalTabs.tsx` (file-size cap):
 * rename (F2) and the unified new-conversation dialog (issue #7). Pure
 * composition over the injected deps — every closure reads the CURRENT
 * render's `state`/`active` (the caller re-creates this hook's return every
 * render, same freshness contract as the inline originals).
 *
 * `requestNewChat` replaces the old separate choose-engine / chat-fork /
 * quick-fork flows: one dialog (`NewChatDialog`), two toggles, four combos:
 *
 *   destination=tab  + context=fresh    → new tab here (old ctrl+e enter,
 *                                         incl. shell / plugin panes)
 *   destination=tab  + context=continue → fork/handoff sibling tab
 *                                         (old `ctrl+a c`)
 *   destination=fork + context=fresh    → QuickTaskComposer child task
 *                                         (old `ctrl+a f`)
 *   destination=fork + context=continue → composer, first prompt led by the
 *                                         transcript handoff brief
 */

import { availableEngineIds } from "@/engine/account-detect"
import { resolveMainRepoRoot } from "@/state/repos"
import { setRepoLastActiveVendor } from "@/state/vendor-prefs"
import type { VendorId } from "@/types/vendor"
import { defaultDaemonSocketPath } from "@sma1lboy/kobe-daemon/daemon/paths"
import { type PaneLaunch, listPaneLaunches } from "@sma1lboy/kobe-daemon/plugins/pane-command"
import { activeCliName } from "../../cli/rename-compat"
import { defaultShell } from "../../tui/panes/terminal/pty-types"
import { openPluginPane } from "../../tui/workspace/pane-split"
import {
  type TabsState,
  type TerminalTab,
  addTab,
  openCommandTab,
  renameActiveTab,
} from "../../tui/workspace/terminal-tabs-core"
import {
  type NewChatChoice,
  type NewChatContext,
  type NewChatDestination,
  NewChatDialog,
} from "../component/new-chat-dialog"
import { QuickTaskComposer, type QuickTaskResult } from "../component/quick-task-composer"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import type { useDialog } from "../ui/dialog"
import {
  type ChatForkPlan,
  addForkTab,
  addHandoffTab,
  planChatContinuation,
  planWorktreeHandoff,
} from "./fork-chat-tab"
import { quickForkComposerOptions } from "./quick-fork"
import { tabTitle } from "./tab-strip"

export interface NewChatPreset {
  readonly destination?: NewChatDestination
  readonly context?: NewChatContext
}

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
  /** Toast for the "nothing to continue from" refusals. */
  notifyError: (title: string) => void
}): {
  requestRename: () => void
  requestNewChat: (preset?: NewChatPreset) => void
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

  const notifyRefusal = (plan: ChatForkPlan): void =>
    deps.notifyError(
      plan.kind === "no-transcript"
        ? t("terminal.tab.noTranscriptToHandOff", { engine: plan.engine })
        : t("terminal.tab.nothingToFork"),
    )

  /** destination=tab: land the picked engine as a sibling tab — fresh
   *  (plain `addTab`) or continuing (fork/handoff, old `ctrl+a c`). */
  const openTabHere = async (choice: NewChatChoice, source: VendorId): Promise<void> => {
    const vendor = choice.pick as VendorId
    if (choice.context === "continue") {
      const plan = await planChatContinuation(active, source, vendor, deps.worktree)
      if (plan.kind === "fork") update(pinSession(addForkTab(state, vendor, plan.sessionId), vendor))
      else if (plan.kind === "handoff") update(pinSession(addHandoffTab(state, vendor, plan.prompt), vendor))
      else notifyRefusal(plan)
      return
    }
    update(pinSession(addTab(state, vendor), vendor))
    deps.onChooseEngine?.(vendor)
    try {
      setRepoLastActiveVendor(resolveMainRepoRoot(deps.worktree), vendor)
    } catch {
      /* best-effort: a stale worktree path must not block the new tab */
    }
  }

  /** destination=fork: the QuickTaskComposer child-task flow (old
   *  `ctrl+a f`), seeded from THIS task's repo/branch and the dialog's
   *  engine pick. With context=continue the created task's first prompt
   *  opens on the transcript handoff brief, then the user's own prompt. */
  const forkChildTask = async (
    choice: NewChatChoice,
    source: VendorId,
    engines: readonly VendorId[],
  ): Promise<void> => {
    let repo: string
    try {
      repo = resolveMainRepoRoot(deps.worktree)
    } catch {
      return
    }
    let contextPrompt: string | undefined
    if (choice.context === "continue") {
      const plan = await planWorktreeHandoff(active, source, deps.worktree)
      if (plan.kind !== "handoff") {
        notifyRefusal(plan)
        return
      }
      contextPrompt = plan.prompt
    }
    const vendor = choice.pick as VendorId
    const result = await QuickTaskComposer.show(
      dialog,
      quickForkComposerOptions(repo, engines.length > 0 ? engines : [vendor], vendor, deps.worktree),
    )
    if (result === undefined) return
    deps.onQuickFork?.(repo, contextPrompt ? { ...result, prompt: `${contextPrompt}\n\n${result.prompt}` } : result)
  }

  /** The unified entry: `ctrl+e` opens it pristine, `ctrl+a c` / `ctrl+a f`
   *  open it with a toggle pre-flipped. Dispatches the four combos above. */
  const requestNewChat = (preset: NewChatPreset = {}): void => {
    void (async () => {
      const source = (active.kind === "engine" ? active.vendor : undefined) ?? deps.vendor
      const available = await availableEngineIds()
      // Installed plugin panes ride the same picker (owner ask 2026-07-29):
      // ctrl+e is "what runs in this tab", and a pane is exactly that. Reads
      // the local registry synchronously — a handful of small files. Only
      // offered in the default combo (the dialog filters otherwise).
      let panes: PaneLaunch[] = []
      try {
        panes = listPaneLaunches({ socketPath: defaultDaemonSocketPath(), binPath: activeCliName() })
      } catch {
        /* registry unreadable → engines only */
      }
      const choice = await NewChatDialog.show(
        dialog,
        available,
        // Continue-presets highlight the tab's own engine (the conversation
        // being continued); the pristine entry keeps ctrl+e's task-engine
        // default.
        preset.context === "continue" ? source : deps.vendor,
        {
          allowShell: true,
          extraChoices: panes.map((p) => ({ key: `pane:${p.pluginId}.${p.paneId}`, label: p.title })),
          initialDestination: preset.destination,
          initialContext: preset.context,
        },
      )
      if (choice === undefined) return
      if (choice.destination === "fork") {
        await forkChildTask(choice, source, available)
        return
      }
      const pane = panes.find((p) => `pane:${p.pluginId}.${p.paneId}` === choice.pick)
      if (pane) {
        update(openPluginPane(state, pane.argv, pane.title, pane.placement, undefined, deps.activeLeafSize()))
        return
      }
      // "shell" = a plain terminal tab (kind "command"): no session pin, no
      // vendor preference write, closes itself on exit. Null label so the
      // tab is named by its live foreground process ("zsh", "vim"…).
      if (choice.pick === "shell") {
        update(openCommandTab(state, [defaultShell()], null))
        return
      }
      await openTabHere(choice, source)
    })()
  }

  return { requestRename, requestNewChat }
}
