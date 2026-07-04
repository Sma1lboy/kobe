/**
 * `ChatPane` — the experimental native chat pane (KOBE_TUI=1), the center
 * column of the single-process opentui workspace (tui/workspace/host.tsx).
 *
 * Rendered INSTEAD of a tmux-hosted interactive engine CLI. Each prompt
 * runs ONE headless `claude -p --output-format stream-json` turn
 * (engine/claude-code-local/headless.ts); between prompts no engine
 * process exists — that's this backend's reason to exist: the always-on
 * interactive CLI's render loop is what cooks laptops under many
 * parallel tasks.
 *
 * Rendering contract: the transcript store holds the SDK stream-json messages
 * VERBATIM and the view reads SDK fields directly (`message.content` blocks,
 * `usage.output_tokens`, `total_cost_usd`, …). No normalization layer between
 * the wire and the screen — by product decision the SDK is the render schema.
 *
 * Conversation continuity: on mount we resume the worktree's newest claude
 * session (same vendor store the `kobe history` pane reads), so a remounted
 * pane — or a task that previously ran interactive claude — continues where
 * it left off instead of starting a fresh conversation. The workspace
 * remounts this component per selected task (keyed on worktree).
 */

import { findClaudeBinary } from "@/engine/claude-code-local/binary"
import { BUILTIN_CLAUDE_SLASHES } from "@/engine/claude-code-local/builtin-slashes"
import { startHeadlessTurn } from "@/engine/claude-code-local/headless"
import { engineEntry, getCapabilities } from "@/engine/registry"
import type { PermissionMode } from "@/types/engine"
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"
import { type ChatItem, ChatRow, sdkResultsByToolUseId } from "./ChatRow"
import { Composer, type ComposerSlashEntry } from "./Composer"
import { ModelPicker, type ModelPickerResult } from "./composer/ModelPicker"
import { permissionModeLabel } from "./composer/permission-mode"
import { loadUserSlashes } from "./composer/user-slashes"

export interface ChatPaneProps {
  readonly worktree: string
  /** Task title for the header; falls back to the worktree basename. */
  readonly title?: string
  /**
   * `--permission-mode` forwarded to every turn. Headless `-p` can't prompt,
   * so tools outside the mode's allowance are denied, not asked.
   * ponytail: static per-pane mode; interactive approval is the upgrade path.
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

export function ChatPane(props: ChatPaneProps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [items, setItems] = createSignal<readonly ChatItem[]>([])
  const [running, setRunning] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [expanded, setExpanded] = createSignal(false)
  const results = createMemo(() => sdkResultsByToolUseId(items()))

  const capabilities = getCapabilities("claude")
  const identity = engineEntry("claude").identity

  // Composer state: pinned model (undefined = claude's default), permission
  // mode (shift+tab cycles the engine's list), and the mid-turn prompt queue.
  const [model, setModel] = createSignal<ModelPickerResult>(undefined)
  const initialMode: PermissionMode = capabilities.permissionModes.some((m) => m.id === props.permissionMode)
    ? (props.permissionMode as PermissionMode)
    : "acceptEdits"
  const [permissionMode, setPermissionMode] = createSignal<PermissionMode>(initialMode)
  const [queue, setQueue] = createSignal<readonly { id: string; kind: "prompt"; text: string }[]>([])

  // Slash-command list: claude's -p-compatible builtins + the user's own
  // `.claude/{commands,skills}/` entries (project + global). Selecting one
  // submits `/name` through the same turn pipeline — `claude -p` executes it.
  const [slashList, setSlashList] = createSignal<readonly ComposerSlashEntry[]>([])
  onMount(() => {
    void loadUserSlashes(props.worktree)
      .then((user) => {
        const builtin: ComposerSlashEntry[] = BUILTIN_CLAUDE_SLASHES.map((s) => ({
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
      .catch(() => {})
  })

  // The conversation to resume — seeded from the worktree's newest claude
  // session at boot, then updated from each turn's SDK `session_id` (a
  // `--resume` turn gets a fresh id; chaining the latest keeps continuity).
  let resumeSessionId: string | undefined
  onMount(() => {
    void engineEntry("claude")
      .history.listSessionIdsForWorktree(props.worktree)
      .then((ids) => {
        if (!resumeSessionId && ids.length > 0) resumeSessionId = ids[ids.length - 1]
      })
      .catch(() => {})
  })

  let activeInterrupt: (() => void) | undefined
  onCleanup(() => activeInterrupt?.())

  async function runTurn(prompt: string): Promise<void> {
    setRunning(true)
    setItems((prev) => [...prev, { kind: "prompt", text: prompt }])
    try {
      const binaryPath = await findClaudeBinary()
      const pick = model()
      const turn = startHeadlessTurn({
        binaryPath,
        cwd: props.worktree,
        prompt,
        resumeSessionId,
        model: pick?.id,
        modelEffort: pick?.effort,
        permissionMode: permissionMode(),
      })
      activeInterrupt = turn.interrupt
      for await (const msg of turn.events) {
        if ("session_id" in msg && typeof msg.session_id === "string") resumeSessionId = msg.session_id
        setItems((prev) => [...prev, { kind: "sdk", msg }])
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      setItems((prev) => [...prev, { kind: "error", text }])
    } finally {
      activeInterrupt = undefined
      setRunning(false)
      drainQueue()
    }
  }

  /** FIFO auto-drain: fire the queue head once the turn ends. */
  function drainQueue(): void {
    queueMicrotask(() => {
      if (running()) return
      const head = queue()[0]
      if (!head) return
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
    const pick = model()
    if (!pick) {
      const id = capabilities.defaultModelId()
      return capabilities.models.find((m) => m.id === id && !m.effort)?.label ?? id
    }
    return (
      capabilities.models.find((m) => m.id === pick.id && m.effort === pick.effort)?.label ??
      (pick.effort ? `${pick.id} · ${pick.effort}` : pick.id)
    )
  }

  function openModelPicker(): void {
    const pick = model()
    dialog.replace(
      () => (
        <ModelPicker
          current={pick?.id}
          currentEffort={pick?.effort}
          currentVendor="claude"
          lockedVendor="claude"
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
    const modes = capabilities.permissionModes
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
        <text fg={theme.success} attributes={TextAttributes.BOLD} wrapMode="none">
          {t("chat.tag")}
        </text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
          {headerTitle()}
        </text>
        <box flexGrow={1} />
        <Show when={running()}>
          <text fg={theme.warning} wrapMode="none">
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
              carries its own marginTop (turn separation). */}
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            <For each={items()}>{(item) => <ChatRow item={item} results={results()} expanded={expanded()} />}</For>
          </box>
        </Show>
      </scrollbox>
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
        inputPlaceholder={() => identity?.inputPlaceholder ?? t("chat.placeholder")}
        slashes={slashList}
        permissionMode={permissionMode}
        permissionModeLabel={() => permissionModeLabel(capabilities, permissionMode())}
        onCyclePermissionMode={cyclePermissionMode}
        onChooseModel={openModelPicker}
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
