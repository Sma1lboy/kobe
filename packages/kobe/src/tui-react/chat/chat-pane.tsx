/** @jsxImportSource @opentui/react */
/**
 * React `ChatPane` — the `src/tui/chat/ChatPane.tsx` counterpart (issue #15
 * G3). Each prompt runs ONE turn through the AI SDK harness backend
 * (engine/ai-sdk/harness-turn.ts) which streams a growing `UIMessage`
 * snapshot per chunk; the transcript holds those UIMessages VERBATIM and the
 * view renders their parts directly (chat-row.tsx). No normalization layer
 * between the harness stream and the screen.
 *
 * React-port seam: `startTurn` is injectable (defaults to the real
 * `startAiSdkTurn`) so `dev:mock-react-chat` can script a fake turn without
 * an engine; `initialPrompt` auto-submits once on mount for the same proof.
 *
 * ponytail: like the Solid pane, no on-disk history yet — a remounted pane
 * starts a fresh harness session.
 */

import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  type AiSdkTurn,
  type AiSdkTurnOpts,
  disposeAiSdkRuntime,
  startAiSdkTurn,
} from "../../engine/ai-sdk/harness-turn"
import { engineEntry, getCapabilities } from "../../engine/registry"
import { permissionModeLabel } from "../../tui/chat/composer/permission-mode"
import type { ComposerQueuedItem } from "../../tui/chat/composer/queue-item"
import { loadUserSlashes } from "../../tui/chat/composer/user-slashes"
import type { PermissionMode } from "../../types/engine"
import { DEFAULT_TASK_VENDOR } from "../../types/task"
import type { VendorId } from "../../types/vendor"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"
import { type ChatItem, ChatRow } from "./chat-row"
import { Composer, type ComposerSlashEntry } from "./composer"
import { ModelPicker, type ModelPickerResult } from "./model-picker"

/** Injectable turn runner — the real harness in production, a script in dev:mock. */
export type StartTurnFn = (opts: AiSdkTurnOpts) => AiSdkTurn

export interface ChatPaneProps {
  readonly worktree: string
  /** Task title for the header; falls back to the worktree basename. */
  readonly title?: string
  /** Engine vendor recorded on the selected task. Native chat supports Claude and Codex. */
  readonly vendor?: VendorId
  /**
   * Initial permission mode for the composer's shift+tab cycle.
   * ponytail: the harness turn doesn't forward it yet — UI seed only.
   */
  readonly permissionMode?: string
  /** Whether this pane owns the keyboard (workspace focus). */
  readonly focused?: () => boolean
  /** dev:mock seam — fake turn runner. Defaults to the real harness. */
  readonly startTurn?: StartTurnFn
  /** dev:mock seam — auto-submit this prompt once on mount. */
  readonly initialPrompt?: string
}

/** Scroll cells per pgup/pgdn keypress. */
const SCROLL_STEP = 10

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

export function ChatTurnErrorBanner(props: { readonly error: string | null }) {
  const { theme } = useTheme()
  const t = useT()
  if (!props.error) return null
  return (
    <box flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
      <text fg={theme.error} wrapMode="word">
        {`${t("chat.errorPrefix")}: ${props.error}`}
      </text>
    </box>
  )
}

export function ChatPane(props: ChatPaneProps) {
  const { theme } = useTheme()
  const t = useT()
  const dialog = useDialog()
  const [items, setItems] = useState<readonly ChatItem[]>([])
  const [running, setRunning] = useState(false)
  const [turnError, setTurnError] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [expanded, setExpanded] = useState(false)

  const vendor = props.vendor ?? DEFAULT_TASK_VENDOR
  const entry = useMemo(() => engineEntry(vendor), [vendor])
  const capabilities = useMemo(() => getCapabilities(vendor), [vendor])
  const identity = entry.identity
  // Engine-owned capability checks, not vendor-id checks (CLAUDE.md
  // "Engine-owned UI data"): native-chat backend gates the model controls,
  // declared permission modes gate the badge/cycle.
  const nativeChat = entry.nativeChat
  const harnessVendor = nativeChat?.harnessVendor
  const hasNativeChat = nativeChat != null
  const hasPermissionModes = (capabilities?.permissionModes.length ?? 0) > 0

  // Composer state: pinned model (undefined = engine default), permission
  // mode (shift+tab cycles the engine's list), and the mid-turn queue.
  const [model, setModel] = useState<ModelPickerResult>(undefined)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() =>
    capabilities?.permissionModes.some((m) => m.id === props.permissionMode)
      ? (props.permissionMode as PermissionMode)
      : "acceptEdits",
  )
  const [queue, setQueue] = useState<readonly ComposerQueuedItem[]>([])
  // Ref twins for the turn pipeline — `drainQueue` fires from a microtask
  // after `done`, where this-render state reads would be stale.
  const runningRef = useRef(false)
  const queueRef = useRef<readonly ComposerQueuedItem[]>([])
  const setRunningBoth = (v: boolean): void => {
    runningRef.current = v
    setRunning(v)
  }
  const updateQueue = (fn: (q: readonly ComposerQueuedItem[]) => readonly ComposerQueuedItem[]): void => {
    queueRef.current = fn(queueRef.current)
    setQueue(queueRef.current)
  }

  const activeInterrupt = useRef<(() => void) | undefined>(undefined)
  const startTurn: StartTurnFn = props.startTurn ?? startAiSdkTurn

  // The AI SDK harness streams growing UIMessage snapshots; the pane
  // replaces the tail "ui" item per update. Held in a render-refreshed ref
  // (useBindings pattern) so the async pipeline (drain microtask, queue
  // callbacks) always dispatches through the LATEST render's closure —
  // matching Solid's read-signals-at-call-time semantics.
  const runTurnRef = useRef<(prompt: string) => Promise<void>>(async () => {})
  runTurnRef.current = async (prompt: string): Promise<void> => {
    setRunningBoth(true)
    setTurnError(null)
    setItems((prev) => [...prev, { kind: "prompt", text: prompt }])
    let hasTail = false
    const turn = startTurn({
      worktree: props.worktree,
      vendor,
      model: model?.id,
      modelEffort: model?.effort,
      prompt,
      onUpdate: (assistant) => {
        setItems((prev) => {
          const next = hasTail ? prev.slice(0, -1) : prev
          hasTail = true
          return [...next, { kind: "ui", msg: assistant }]
        })
      },
    })
    activeInterrupt.current = turn.interrupt
    const { error } = await turn.done
    if (error) {
      // Banner is ephemeral (cleared on next submit); the error row keeps
      // the failure in the transcript history.
      const message = "code" in error ? t("chat.runtimeBusy") : error.message
      setTurnError(message)
      setItems((prev) => [...prev, { kind: "error", text: message }])
    }
    activeInterrupt.current = undefined
    setRunningBoth(false)
    drainQueue()
  }

  /** FIFO auto-drain: fire the queue head once the turn ends. */
  function drainQueue(): void {
    queueMicrotask(() => {
      if (runningRef.current) return
      const head = queueRef.current[0]
      // ponytail: this pane only ever enqueues prompts (no bash items).
      if (head?.kind !== "prompt") return
      updateQueue((q) => q.slice(1))
      void runTurnRef.current(head.text)
    })
  }

  /**
   * Submit pipeline shared by the composer, slash entries, and the queue.
   * `auto` queues while a turn is in flight; `steer` interrupts the live
   * turn and lets the drain fire this prompt next.
   */
  const submitRef = useRef<(text: string, mode?: "auto" | "steer") => void>(() => {})
  submitRef.current = (text: string, mode: "auto" | "steer" = "auto"): void => {
    const prompt = text.trim()
    if (!prompt) return
    setDraft("")
    setTurnError(null)
    if (!runningRef.current) {
      void runTurnRef.current(prompt)
      return
    }
    if (mode === "steer") {
      updateQueue((q) => [{ id: `q-${Date.now()}-${q.length}`, kind: "prompt" as const, text: prompt }, ...q])
      activeInterrupt.current?.()
      return
    }
    updateQueue((q) => [...q, { id: `q-${Date.now()}-${q.length}`, kind: "prompt" as const, text: prompt }])
  }
  const submit = (text: string, mode?: "auto" | "steer") => submitRef.current(text, mode)

  // Slash-command list: engine-owned builtins + the user's own
  // `.claude/{commands,skills}/` entries, gated on the engine-owned
  // `userSlashes` capability (never a vendor-id string).
  const [slashList, setSlashList] = useState<readonly ComposerSlashEntry[]>([])
  useEffect(() => {
    if (!nativeChat?.userSlashes) return
    let disposed = false
    void loadUserSlashes(props.worktree)
      .then((user) => {
        if (disposed) return
        const builtin: ComposerSlashEntry[] = (nativeChat?.builtinSlashes ?? []).map((s) => ({
          display: `/${s.name}`,
          description: s.description,
          aliases: s.aliases ? [...s.aliases] : undefined,
          source: "builtin",
          onSelect: () => submitRef.current(`/${s.name}`),
        }))
        const userEntries: ComposerSlashEntry[] = user.map((s) => ({
          display: `/${s.name}`,
          description: s.description,
          source: "user",
          onSelect: () => submitRef.current(`/${s.name}`),
        }))
        setSlashList([...builtin, ...userEntries])
      })
      .catch((err) => console.error("[kobe chat] failed to load user slash commands:", err))
    return () => {
      disposed = true
    }
  }, [props.worktree, nativeChat])

  // dev:mock seam — auto-submit the scripted prompt once on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once by design (scripted proof prompt).
  useEffect(() => {
    if (props.initialPrompt) submitRef.current(props.initialPrompt)
  }, [])

  // Unmount: interrupt a live turn, drop the per-worktree harness runtime.
  useEffect(
    () => () => {
      activeInterrupt.current?.()
      disposeAiSdkRuntime(props.worktree)
    },
    [props.worktree],
  )

  /** Footer label for the pinned (or default) model, from the vendor catalog. */
  const modelLabel = (): string => {
    const caps = capabilities
    const pick = model
    if (!pick) {
      const id = caps?.defaultModelId() ?? ""
      return caps?.models.find((m) => m.id === id && !m.effort)?.label ?? id
    }
    return (
      caps?.models.find((m) => m.id === pick.id && m.effort === pick.effort)?.label ??
      (pick.effort ? `${pick.id} · ${pick.effort}` : pick.id)
    )
  }

  function openModelPicker(): void {
    const hv = harnessVendor
    if (!hv) return
    const pick = model
    dialog.replace(
      () => (
        <ModelPicker
          current={pick?.id}
          currentEffort={pick?.effort}
          currentVendor={hv}
          lockedVendor={hv}
          onPick={(choice) => {
            setModel(choice)
            dialog.clear()
          }}
          onCancel={() => dialog.clear()}
        />
      ),
      () => {},
    )
  }

  function cyclePermissionMode(): void {
    const modes = capabilities?.permissionModes ?? []
    if (modes.length === 0) return
    setPermissionMode((current) => {
      const i = modes.findIndex((m) => m.id === current)
      return modes[(i + 1) % modes.length]?.id ?? "acceptEdits"
    })
  }

  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const scrollBy = (dy: number): void => {
    const scroll = scrollRef.current
    if (!scroll) return
    scroll.scrollTo({ x: 0, y: Math.max(0, scroll.scrollTop + dy) })
  }

  const paneFocused = (): boolean => props.focused?.() ?? true

  useBindings(() => ({
    // Pane-scoped: only when the workspace column owns the keyboard.
    enabled: paneFocused(),
    bindings: [
      // pgup/pgdn + ctrl+o only: the composer input owns letters/arrows/enter.
      { key: "pageup", cmd: () => scrollBy(-SCROLL_STEP) },
      { key: "pagedown", cmd: () => scrollBy(SCROLL_STEP) },
      { key: "ctrl+o", cmd: () => setExpanded((e) => !e) },
      ...(running ? [{ key: "escape", cmd: () => activeInterrupt.current?.() }] : []),
    ],
  }))

  const headerTitle = props.title?.trim() || basename(props.worktree)

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      {/* Quiet brand header — muted CAPS tag + plain bold title; one accent
          per surface (the transcript's ❯ prompt marker). */}
      <box
        flexDirection="row"
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        backgroundColor={theme.backgroundElement}
      >
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
          {t("chat.tag")}
        </text>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {headerTitle}
        </text>
        <box flexGrow={1} />
        {running ? (
          <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
            {t("chat.working")}
          </text>
        ) : null}
      </box>
      <scrollbox
        ref={(r: ScrollBoxRenderable | null) => {
          scrollRef.current = r
        }}
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
      >
        {items.length > 0 ? (
          /* No paddingTop — the first row is always a prompt echo, which
             carries its own marginTop. The streaming UIMessage snapshot
             grows in place, so it IS the live view. */
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            {items.map((item, i) => (
              <ChatRow key={`${item.kind}:${i}`} item={item} expanded={expanded} />
            ))}
          </box>
        ) : (
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>{t("chat.empty")}</text>
          </box>
        )}
      </scrollbox>
      <ChatTurnErrorBanner error={turnError} />
      {/* The full composer: multi-line textarea, per-key prompt history
          (↑↓ + ctrl+r palette), `/` slash dropdown, `@` file mentions, image
          paste, model picker, shift+tab permission cycle, mid-turn queue. */}
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        isStreaming={running}
        hasTask={true}
        onSubmit={(text, mode) => submit(text, mode)}
        historyKey={props.worktree}
        focused={paneFocused}
        modelLabel={modelLabel}
        inputPlaceholder={() => identity?.inputPlaceholder ?? t("chat.placeholder")}
        slashes={() => slashList}
        permissionMode={hasPermissionModes ? () => permissionMode : undefined}
        permissionModeLabel={
          hasPermissionModes
            ? () => permissionModeLabel(capabilities ?? { permissionModes: [] }, permissionMode)
            : undefined
        }
        onCyclePermissionMode={hasPermissionModes ? cyclePermissionMode : undefined}
        onChooseModel={hasNativeChat ? openModelPicker : undefined}
        worktreePath={() => props.worktree}
        queue={() => queue}
        onCancelQueued={(id) => updateQueue((q) => q.filter((e) => e.id !== id))}
        onSendQueuedNow={(id) => {
          const entryNow = queueRef.current.find((e) => e.id === id)
          if (!entryNow) return
          updateQueue((q) => [entryNow, ...q.filter((e) => e.id !== id)])
          activeInterrupt.current?.()
        }}
        currentProjectRoot={() => props.worktree}
      />
      <box paddingLeft={1} paddingRight={1} flexShrink={0} backgroundColor={theme.backgroundElement}>
        <text fg={theme.textMuted} wrapMode="none">
          {running ? t("chat.hintRunning") : t("chat.hint")}
        </text>
      </box>
    </box>
  )
}
