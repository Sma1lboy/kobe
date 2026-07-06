/**
 * `ChatPane` — the experimental native chat pane (KOBE_TUI=1), the center
 * column of the single-process opentui workspace (tui/workspace/host.tsx).
 *
 * Rendered INSTEAD of a tmux-hosted interactive engine CLI. Each prompt runs
 * ONE turn through the AI SDK harness backend (engine/ai-sdk/harness-turn.ts),
 * which drives the locally-installed Claude Code runtime (subscription login)
 * and streams a growing `UIMessage` snapshot per chunk. No long-lived engine
 * process idles between prompts — that's this backend's reason to exist: the
 * always-on interactive CLI's render loop is what cooks laptops under many
 * parallel tasks.
 *
 * Rendering contract: the transcript holds the harness `UIMessage`s VERBATIM
 * and the view renders their parts directly (ChatRow's UiPartView). No
 * normalization layer between the harness stream and the screen — by product
 * decision the UIMessage is the render schema.
 *
 * ponytail: this pane keeps no on-disk history yet — a remounted pane starts a
 * fresh harness session. Resuming from claude's session records is future work
 * at the persistence boundary (see harness-turn.ts), not wired here.
 */

import { disposeAiSdkRuntime, historyTokenBudgetForContextWindow, startAiSdkTurn } from "@/engine/ai-sdk/harness-turn"
import { callAiSdkModelRouter, chooseTurnModel } from "@/engine/ai-sdk/model-router"
import { engineEntry, getCapabilities } from "@/engine/registry"
import { nativeChatAutoModelEnabled } from "@/state/native-chat-router"
import type { PermissionMode } from "@/types/engine"
import { DEFAULT_TASK_VENDOR } from "@/types/task"
import type { VendorId } from "@/types/vendor"
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"
import { type ChatItem, ChatRow } from "./ChatRow"
import { Composer, type ComposerSlashEntry } from "./Composer"
import type { ComposerQueuedItem } from "./ComposerQueue"
import { ModelPicker, type ModelPickerResult } from "./composer/ModelPicker"
import { permissionModeLabel } from "./composer/permission-mode"
import { loadUserSlashes } from "./composer/user-slashes"
import { chatItemsToAiSdkHistory } from "./thread-history"

export interface ChatPaneProps {
  readonly worktree: string
  /** Task title for the header; falls back to the worktree basename. */
  readonly title?: string
  /** Engine vendor recorded on the selected task. Native chat supports Claude and Codex. */
  readonly vendor?: VendorId
  /**
   * Initial permission mode for the composer's shift+tab cycle.
   * ponytail: the harness turn doesn't forward it yet (see hasNativeChat),
   * so this is the seed for the UI, not an enforced per-turn setting.
   */
  readonly permissionMode?: string
  /**
   * Whether this pane owns the keyboard (workspace focus). Gates the
   * composer's textarea focus and the pane-scoped bindings (esc / ctrl+o /
   * pgup / pgdn) so the sidebar and terminal keep their own keys.
   */
  readonly focused?: () => boolean
}

/** Scroll cells per pgup/pgdn keypress. */
const SCROLL_STEP = 10

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

export function ChatTurnErrorBanner(props: { readonly error: string | null }) {
  const { theme } = useTheme()
  return (
    <Show when={props.error}>
      {(error) => (
        <box flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
          <text fg={theme.error} wrapMode="word">
            {`${t("chat.errorPrefix")}: ${error()}`}
          </text>
        </box>
      )}
    </Show>
  )
}

export function ChatPane(props: ChatPaneProps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [items, setItems] = createSignal<readonly ChatItem[]>([])
  const [running, setRunning] = createSignal(false)
  const [turnError, setTurnError] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal("")
  const [expanded, setExpanded] = createSignal(false)

  const vendor = createMemo<VendorId>(() => props.vendor ?? DEFAULT_TASK_VENDOR)
  const entry = createMemo(() => engineEntry(vendor()))
  const capabilities = createMemo(() => getCapabilities(vendor()))
  const identity = createMemo(() => entry().identity)
  // Engine-owned capability: does this engine have a native-chat (harness)
  // backend, and which harness family does it map to? Gates the composer's
  // model controls (and resolves the harness vendor) instead of comparing
  // vendor-id strings in the TUI (CLAUDE.md "Engine-owned UI data").
  const nativeChat = createMemo(() => entry().nativeChat)
  const harnessVendor = createMemo(() => nativeChat()?.harnessVendor)

  // Composer state: pinned model (undefined = claude's default), permission
  // mode (shift+tab cycles the engine's list), and the mid-turn prompt queue.
  const [model, setModel] = createSignal<ModelPickerResult>(undefined)
  const initialMode: PermissionMode = capabilities()?.permissionModes.some((m) => m.id === props.permissionMode)
    ? (props.permissionMode as PermissionMode)
    : "acceptEdits"
  const [permissionMode, setPermissionMode] = createSignal<PermissionMode>(initialMode)
  const [queue, setQueue] = createSignal<readonly ComposerQueuedItem[]>([])

  // Composer model controls show when the engine has a native-chat backend;
  // the permission badge/cycle needs actual modes to offer (codex declares
  // none, so it must not render a dead `acceptEdits ▾`). Both are capability
  // checks, not vendor-id checks.
  // ponytail: permissionMode is surfaced + cycled here but the harness turn
  // doesn't forward it yet — createClaudeCode exposes no permission surface.
  // Wire it through startAiSdkTurn when the harness gains one.
  const hasNativeChat = () => nativeChat() != null
  const hasPermissionModes = () => (capabilities()?.permissionModes.length ?? 0) > 0

  // Slash-command list: claude's builtins + the user's own
  // `.claude/{commands,skills}/` entries (project + global). Selecting one
  // submits `/name` through the same turn pipeline — the harness runtime runs it.
  const [slashList, setSlashList] = createSignal<readonly ComposerSlashEntry[]>([])
  onMount(() => {
    // Builtin slashes are engine-owned data on the nativeChat descriptor; the
    // user-slash loader runs only for engines that declare user-slash
    // directories (the `.claude/{commands,skills}/` convention), gated on the
    // engine-owned `userSlashes` capability rather than a vendor-id string.
    if (!nativeChat()?.userSlashes) return
    void loadUserSlashes(props.worktree)
      .then((user) => {
        const builtin: ComposerSlashEntry[] = (nativeChat()?.builtinSlashes ?? []).map((s) => ({
          display: `/${s.name}`,
          description: s.description,
          aliases: s.aliases ? [...s.aliases] : undefined,
          source: "builtin",
          onSelect: () => submit(`/${s.name}`),
        }))
        const userEntries: ComposerSlashEntry[] = user.map((s) => ({
          display: `/${s.name}`,
          description: s.description,
          source: "user",
          onSelect: () => submit(`/${s.name}`),
        }))
        setSlashList([...builtin, ...userEntries])
      })
      .catch((err) => console.error("[kobe chat] failed to load user slash commands:", err))
  })

  let activeInterrupt: (() => void) | undefined
  onCleanup(() => activeInterrupt?.())
  onCleanup(() => {
    void disposeAiSdkRuntime(props.worktree)
  })

  // The AI SDK harness drives the local Claude Code runtime (subscription
  // login) and streams growing UIMessage snapshots; the pane replaces the tail
  // "ui" item per update.
  async function runTurn(prompt: string): Promise<void> {
    setRunning(true)
    setTurnError(null)
    const history = chatItemsToAiSdkHistory(items())
    const caps = capabilities()
    const autoModel = nativeChatAutoModelEnabled()
    const turnModel = autoModel
      ? await chooseTurnModel({
          vendor: vendor(),
          prompt,
          history,
          current: model(),
          capabilities: caps,
          autoModelEnabled: true,
          callSmallModel: (request) => callAiSdkModelRouter({ ...request, worktree: props.worktree }),
        })
      : model()
    if (autoModel) setModel(turnModel)
    const turnModelId = turnModel?.id ?? caps?.defaultModelId()
    const contextWindow = turnModelId ? (caps?.contextWindowFor(turnModelId) ?? 0) : 0
    setItems((prev) => [...prev, { kind: "prompt", text: prompt }])
    let hasTail = false
    const turn = startAiSdkTurn({
      worktree: props.worktree,
      vendor: vendor(),
      model: turnModel?.id,
      modelEffort: turnModel?.effort,
      history,
      historyTokenBudget: historyTokenBudgetForContextWindow(contextWindow),
      prompt,
      onUpdate: (assistant) => {
        setItems((prev) => {
          const next = hasTail ? prev.slice(0, -1) : prev
          hasTail = true
          return [...next, { kind: "ui", msg: assistant }]
        })
      },
    })
    activeInterrupt = turn.interrupt
    const { error } = await turn.done
    if (error) {
      // Banner is ephemeral (cleared on next submit); also append an error row
      // so the failure persists in the transcript history.
      const message = "code" in error ? t("chat.runtimeBusy") : error.message
      setTurnError(message)
      setItems((prev) => [...prev, { kind: "error", text: message }])
    }
    activeInterrupt = undefined
    setRunning(false)
    drainQueue()
  }

  /** FIFO auto-drain: fire the queue head once the turn ends. */
  function drainQueue(): void {
    queueMicrotask(() => {
      if (running()) return
      const head = queue()[0]
      // ponytail: this pane only ever enqueues prompts (no bash items), so the
      // non-prompt arm of ComposerQueuedItem is unreachable here.
      if (head?.kind !== "prompt") return
      setQueue((q) => q.slice(1))
      void runTurn(head.text)
    })
  }

  /**
   * Submit pipeline shared by the composer, slash entries, and the queue.
   * `auto` queues while a turn is in flight; `steer` interrupts the live
   * turn and lets the drain fire this prompt next.
   */
  function submit(text: string, mode: "auto" | "steer" = "auto"): void {
    const prompt = text.trim()
    if (!prompt) return
    setDraft("")
    setTurnError(null)
    if (!running()) {
      void runTurn(prompt)
      return
    }
    if (mode === "steer") {
      setQueue((q) => [{ id: `q-${Date.now()}-${q.length}`, kind: "prompt" as const, text: prompt }, ...q])
      activeInterrupt?.()
      return
    }
    setQueue((q) => [...q, { id: `q-${Date.now()}-${q.length}`, kind: "prompt" as const, text: prompt }])
  }

  /** Footer label for the pinned (or default) model, from the vendor catalog. */
  const modelLabel = (): string => {
    const caps = capabilities()
    const pick = model()
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
    const hv = harnessVendor()
    if (!hv) return
    const pick = model()
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
    const modes = capabilities()?.permissionModes ?? []
    if (modes.length === 0) return
    const i = modes.findIndex((m) => m.id === permissionMode())
    setPermissionMode(modes[(i + 1) % modes.length]?.id ?? "acceptEdits")
  }

  let scrollRef: ScrollBoxRenderable | undefined
  const scrollBy = (dy: number): void => {
    if (!scrollRef) return
    scrollRef.scrollTo({ x: 0, y: Math.max(0, scrollRef.scrollTop + dy) })
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
      ...(running() ? [{ key: "escape", cmd: () => activeInterrupt?.() }] : []),
    ],
  }))

  const headerTitle = (): string => props.title?.trim() || basename(props.worktree)

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      {/* Brand header — CHAT tag · title · running state. */}
      <box
        flexDirection="row"
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        backgroundColor={theme.backgroundElement}
      >
        {/* Quiet header — muted CAPS tag + plain bold title. One accent per
            surface: the transcript's ❯ prompt marker; the header stays gray. */}
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
          {t("chat.tag")}
        </text>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {headerTitle()}
        </text>
        <box flexGrow={1} />
        <Show when={running()}>
          <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
            {t("chat.working")}
          </text>
        </Show>
      </box>
      <scrollbox
        ref={(r: ScrollBoxRenderable) => {
          scrollRef = r
        }}
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
      >
        <Show
          when={items().length > 0}
          fallback={
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted}>{t("chat.empty")}</text>
            </box>
          }
        >
          {/* No paddingTop — the first row is always a prompt echo, which
              carries its own marginTop (turn separation). The streaming
              UIMessage snapshot grows in place, so it IS the live view. */}
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            <For each={items()}>{(item) => <ChatRow item={item} expanded={expanded()} />}</For>
          </box>
        </Show>
      </scrollbox>
      <ChatTurnErrorBanner error={turnError()} />
      {/* The full v0.5 composer: multi-line textarea, per-key prompt history
          (↑↓ + ctrl+r palette), `/` slash dropdown, `@` file mentions, image
          paste, model picker, shift+tab permission cycle, mid-turn queue. */}
      <Composer
        draft={draft()}
        onDraftChange={setDraft}
        isStreaming={running()}
        hasTask={true}
        onSubmit={(text, mode) => submit(text, mode)}
        historyKey={props.worktree}
        focused={paneFocused}
        modelLabel={modelLabel}
        inputPlaceholder={() => identity()?.inputPlaceholder ?? t("chat.placeholder")}
        slashes={slashList}
        permissionMode={hasPermissionModes() ? permissionMode : undefined}
        permissionModeLabel={
          hasPermissionModes()
            ? () => permissionModeLabel(capabilities() ?? { permissionModes: [] }, permissionMode())
            : undefined
        }
        onCyclePermissionMode={hasPermissionModes() ? cyclePermissionMode : undefined}
        onChooseModel={hasNativeChat() ? openModelPicker : undefined}
        worktreePath={() => props.worktree}
        queue={queue}
        onCancelQueued={(id) => setQueue((q) => q.filter((e) => e.id !== id))}
        onSendQueuedNow={(id) => {
          const entry = queue().find((e) => e.id === id)
          if (!entry) return
          setQueue((q) => [entry, ...q.filter((e) => e.id !== id)])
          activeInterrupt?.()
        }}
        currentProjectRoot={() => props.worktree}
      />
      <box paddingLeft={1} paddingRight={1} flexShrink={0} backgroundColor={theme.backgroundElement}>
        <text fg={theme.textMuted} wrapMode="none">
          {running() ? t("chat.hintRunning") : t("chat.hint")}
        </text>
      </box>
    </box>
  )
}
