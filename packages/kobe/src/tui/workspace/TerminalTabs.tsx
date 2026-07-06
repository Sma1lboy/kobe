import type { TranscriptActivity } from "@/client/remote-orchestrator"
import { availableEngineIds } from "@/engine/account-detect"
import { interactiveEngineCommand, withClaudeSessionId } from "@/engine/interactive-command"
import { engineEntry } from "@/engine/registry"
import type { ChatTabTurnState } from "@/engine/turn-detector"
import { deriveTitleFromSessionId } from "@/monitor/auto-title"
import { resolveMainRepoRoot } from "@/state/repos"
import { setRepoLastActiveVendor } from "@/state/vendor-prefs"
import type { VendorId } from "@/types/vendor"
import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import { EnginePickerDialog } from "../component/engine-picker-dialog/index"
import { RenameTaskDialog } from "../component/rename-task-dialog/index"
import { bindByIds } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../lib/keymap"
import { startTurnStatusPoll } from "../ops/activity-monitor"
import type { Terminal } from "../panes/terminal/Terminal"
import { defaultShell } from "../panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../panes/terminal/registry"
import { useDialog } from "../ui/dialog"
import { TerminalSplit, releaseSplitLeaves } from "./TerminalSplit"
import {
  type EngineTab,
  type TabsState,
  type TerminalTab,
  addTab,
  closeActiveTab,
  closeTab,
  cycleTab,
  initialTabs,
  markTabSpawned,
  openEditorTab,
  rehydrateTabs,
  renameActiveTab,
  selectTab,
  setTabAutoTitle,
  setTabSessionId,
  tabPtyKey,
  tabToShell,
} from "./terminal-tabs-core"

const tabsByTask = new Map<string, TabsState>()

const NAMING_POLL_MS = 5000
const TURN_POLL_ATTACH_MS = 2000

const TURN_GLYPHS: Record<ChatTabTurnState, string> = {
  running: "●",
  done: "✓",
  error: "!",
  unknown: "?",
  idle: "○",
}

function tabTitle(tab: TerminalTab): string {
  return tab.title ?? tab.autoTitle ?? t("terminal.tab.defaultTitle", { n: tab.ordinal })
}

export function TerminalTabs(props: {
  taskId: string
  worktree: string
  command: readonly string[]
  vendor: VendorId
  modelEffort?: string
  onChooseEngine?: (vendor: VendorId) => void
  onEditorTabReady?: (open: (command: readonly string[], label: string) => void) => void
  sharedActivity?: () => TranscriptActivity | null
  focused: () => boolean
}): ReturnType<typeof Terminal> {
  const { theme } = useTheme()
  const dialog = useDialog()
  const notif = useNotifications()
  const kv = useKV()
  const persistKey = `terminalTabs.${props.taskId}`

  const pinSession = (s: TabsState, vendor: VendorId | undefined): TabsState => {
    const base = vendor ? interactiveEngineCommand(vendor, props.modelEffort) : props.command
    const { sessionId } = withClaudeSessionId(base, vendor ?? props.vendor)
    return setTabSessionId(s, s.activeId, sessionId)
  }

  const initState = (): TabsState => {
    const existing = tabsByTask.get(props.taskId)
    if (existing) return existing
    const saved = kv.get(persistKey, null) as TabsState | null
    const fresh = saved && Array.isArray(saved.tabs) ? rehydrateTabs(saved) : pinSession(initialTabs(), undefined)
    tabsByTask.set(props.taskId, fresh)
    return fresh
  }

  const [state, setState] = createSignal<TabsState>(initState())
  const update = (next: TabsState): void => {
    tabsByTask.set(props.taskId, next)
    setState(next)
    kv.set(persistKey, next)
  }

  const engineTabCommand = (tab: EngineTab): readonly string[] => {
    const base = tab.vendor ? interactiveEngineCommand(tab.vendor, props.modelEffort) : props.command
    if (!tab.sessionId) return base
    const live = getDefaultPtyRegistry().has(tabPtyKey(props.taskId, tab.id))
    if (tab.spawned && !live) return [...base, "--resume", tab.sessionId]
    return [...base, "--session-id", tab.sessionId]
  }

  createEffect(() => {
    const tab = active()
    if (tab?.kind === "engine" && !tab.spawned) update(markTabSpawned(state(), tab.id))
  })

  props.onEditorTabReady?.((command, label) => update(openEditorTab(state(), command, label)))

  const active = () => state().tabs.find((tab) => tab.id === state().activeId) ?? state().tabs[0]

  let namingBusy = false
  const namingTimer = setInterval(() => {
    if (namingBusy) return
    const candidates = state().tabs.filter(
      (tab): tab is EngineTab => tab.kind === "engine" && !!tab.sessionId && !tab.title && !tab.autoTitle,
    )
    if (candidates.length === 0) return
    namingBusy = true
    void (async () => {
      try {
        for (const tab of candidates) {
          if (!tab.sessionId) continue
          const title = await deriveTitleFromSessionId(tab.vendor ?? props.vendor, tab.sessionId)
          if (title) update(setTabAutoTitle(state(), tab.id, title))
        }
      } finally {
        namingBusy = false
      }
    })()
  }, NAMING_POLL_MS)
  onCleanup(() => clearInterval(namingTimer))

  const [turnStates, setTurnStates] = createSignal<ReadonlyMap<string, ChatTabTurnState>>(new Map())
  const turnPolls = new Map<string, () => void>()
  const [pollTick, setPollTick] = createSignal(0)
  const pollAttachTimer = setInterval(() => setPollTick((n) => n + 1), TURN_POLL_ATTACH_MS)
  onCleanup(() => clearInterval(pollAttachTimer))
  createEffect(() => {
    pollTick()
    const reg = getDefaultPtyRegistry()
    const engineIds = new Set<string>()
    for (const tab of state().tabs) {
      if (tab.kind !== "engine") continue
      engineIds.add(tab.id)
      if (turnPolls.has(tab.id)) continue
      const key = tabPtyKey(props.taskId, tab.id)
      if (!reg.has(key)) continue
      const tabId = tab.id
      const detector = engineEntry(tab.vendor ?? props.vendor).createTurnDetector()
      const dispose = startTurnStatusPoll(
        {
          worktree: props.worktree,
          detector,
          usingShared: () => (props.sharedActivity?.() ?? null) !== null,
          sharedEntry: () => props.sharedActivity?.() ?? null,
        },
        {
          sessionAttached: async () => true,
          capturePane: async () => {
            const pty = getDefaultPtyRegistry().get(key)
            if (!pty) throw new Error("pty gone")
            return pty
              .capture()
              .map((row) => row.map((chunk) => chunk.text).join(""))
              .join("\n")
          },
          setTurnState: async (turn) => {
            setTurnStates((prev) => new Map(prev).set(tabId, turn))
            if (turn === "done" && state().activeId !== tabId) {
              const current = state().tabs.find((t) => t.id === tabId)
              if (current) notif.notify({ kind: "done", taskId: props.taskId, tabId, title: tabTitle(current) })
            }
          },
        },
      )
      turnPolls.set(tabId, dispose)
    }
    for (const [id, dispose] of turnPolls) {
      if (engineIds.has(id)) continue
      dispose()
      turnPolls.delete(id)
      setTurnStates((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    }
  })
  onCleanup(() => {
    for (const dispose of turnPolls.values()) dispose()
  })

  createEffect(
    on(
      () => state().activeId,
      (activeId) => notif.markRead(props.taskId, activeId),
    ),
  )

  const [resetToken, setResetToken] = createSignal(0)

  function closeExitedTab(id: string): void {
    const { state: next, closedId } = closeTab(state(), id)
    if (closedId) {
      releaseSplitLeaves(tabPtyKey(props.taskId, closedId))
      getDefaultPtyRegistry().release(tabPtyKey(props.taskId, closedId))
    }
    update(next)
  }

  function degradeToShell(id: string): void {
    const tab = state().tabs.find((t) => t.id === id)
    if (tab?.kind !== "engine") return
    const wasActive = id === state().activeId
    update(tabToShell(state(), id, [defaultShell()]))
    getDefaultPtyRegistry().release(tabPtyKey(props.taskId, id))
    if (wasActive) setResetToken((n) => n + 1)
  }

  const activeCommand = (): readonly string[] => {
    const tab = active()
    return tab.kind === "command" ? tab.command : engineTabCommand(tab)
  }

  function handleActiveExit(): void {
    const tab = active()
    if (tab.kind === "command") closeExitedTab(tab.id)
    else degradeToShell(tab.id)
  }

  const requestRename = (): void => {
    const tab = active()
    if (!tab) return
    void RenameTaskDialog.show(dialog, tabTitle(tab), {
      dialogTitle: t("terminal.tab.renameTitle"),
      fieldLabel: t("terminal.tab.renameField"),
      submitLabel: t("terminal.tab.renameSubmit"),
      allowEmpty: true,
    }).then((title) => {
      if (title === undefined) return
      update(renameActiveTab(state(), title))
    })
  }

  const requestChooseEngine = (): void => {
    void (async () => {
      const available = await availableEngineIds()
      const picked = await EnginePickerDialog.show(dialog, available, props.vendor)
      if (picked === undefined) return
      update(pinSession(addTab(state(), picked), picked))
      props.onChooseEngine?.(picked)
      try {
        setRepoLastActiveVendor(resolveMainRepoRoot(props.worktree), picked)
      } catch {}
    })()
  }

  useBindings(() => ({
    enabled: props.focused(),
    bindings: bindByIds({
      "chat.tab.new": () => update(pinSession(addTab(state()), undefined)),
      "chat.tab.chooseEngine": requestChooseEngine,
      "chat.tab.close": () => {
        const { state: next, closedId } = closeActiveTab(state())
        if (!closedId) {
          notif.notify({
            kind: "error",
            taskId: props.taskId,
            tabId: state().activeId,
            title: t("terminal.tab.cannotCloseLast"),
          })
          return
        }
        update(next)
        releaseSplitLeaves(tabPtyKey(props.taskId, closedId))
        getDefaultPtyRegistry().release(tabPtyKey(props.taskId, closedId))
      },
      "chat.tab.rename": requestRename,
      "chat.tab.cycle-next": () => update(cycleTab(state(), 1)),
      "chat.tab.cycle-prev": () => update(cycleTab(state(), -1)),
    }),
  }))

  return (
    <box flexDirection="column" flexGrow={1}>
      {}
      <Show when={state().tabs.length > 1}>
        <box flexDirection="row" gap={1} flexShrink={0} paddingLeft={1} backgroundColor={theme.backgroundElement}>
          <For each={state().tabs}>
            {(tab) => {
              const turn = () => turnStates().get(tab.id) ?? "idle"
              const turnColor = () =>
                turn() === "running"
                  ? theme.focusAccent
                  : turn() === "done"
                    ? theme.success
                    : turn() === "error"
                      ? theme.error
                      : theme.textMuted
              return (
                <box flexDirection="row" gap={0} onMouseUp={() => update(selectTab(state(), tab.id))}>
                  {}
                  <Show when={tab.kind === "engine"}>
                    <text fg={turnColor()} wrapMode="none">
                      {`${TURN_GLYPHS[turn()]} `}
                    </text>
                  </Show>
                  <text
                    fg={tab.id === state().activeId ? theme.focusAccent : theme.textMuted}
                    attributes={tab.id === state().activeId ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {tabTitle(tab)}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
      {}
      <TerminalSplit
        tabKey={tabPtyKey(props.taskId, active().id)}
        cwd={() => props.worktree}
        command={activeCommand()}
        onExit={handleActiveExit}
        resetToken={resetToken}
        focused={props.focused}
      />
    </box>
  )
}
