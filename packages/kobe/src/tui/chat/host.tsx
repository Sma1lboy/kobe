/**
 * `kobe chat` host — the experimental native chat pane (KOBE_TUI=1).
 *
 * Launched into the task's engine pane slot INSTEAD of the interactive engine
 * CLI (the tmux handover). Each prompt runs ONE headless `claude -p
 * --output-format stream-json` turn (engine/claude-code-local/headless.ts);
 * between prompts no engine process exists — that's this backend's reason to
 * exist: the always-on interactive CLI's render loop is what cooks laptops
 * under many parallel tasks.
 *
 * Rendering contract: the transcript store holds the SDK stream-json messages
 * VERBATIM and the view reads SDK fields directly (`message.content` blocks,
 * `usage.output_tokens`, `total_cost_usd`, …). No normalization layer between
 * the wire and the screen — by product decision the SDK is the render schema.
 *
 * Conversation continuity: on boot we resume the worktree's newest claude
 * session (same vendor store the `kobe history` pane reads), so a relaunched
 * pane — or a task that previously ran interactive claude — continues where
 * it left off instead of starting a fresh conversation.
 */

import { findClaudeBinary } from "@/engine/claude-code-local/binary"
import type { SdkContentBlock, SdkMessage, SdkToolResultBlock } from "@/engine/claude-code-local/headless"
import { startHeadlessTurn } from "@/engine/claude-code-local/headless"
import { engineEntry } from "@/engine/registry"
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { BodyLines, bodyText, toolInputSummary } from "../history/host"
import { t } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"

export interface ChatHostArgs {
  readonly worktree: string
  /** Task title for the header; falls back to the worktree basename. */
  readonly title?: string
  /**
   * `--permission-mode` forwarded to every turn. Headless `-p` can't prompt,
   * so tools outside the mode's allowance are denied, not asked.
   * ponytail: static per-pane mode; interactive approval is the upgrade path.
   */
  readonly permissionMode?: string
}

/** Transcript entries: the typed prompt echo, SDK messages verbatim, spawn-level failures. */
type ChatItem =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "sdk"; readonly msg: SdkMessage }
  | { readonly kind: "error"; readonly text: string }

/** Scroll cells per pgup/pgdn keypress. */
const SCROLL_STEP = 10

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

/** Index tool_result blocks (SDK `user` messages) by their `tool_use_id`. */
function sdkResultsByToolUseId(items: readonly ChatItem[]): Map<string, SdkToolResultBlock> {
  const map = new Map<string, SdkToolResultBlock>()
  for (const item of items) {
    if (item.kind !== "sdk" || item.msg.type !== "user") continue
    for (const block of item.msg.message.content) {
      if (block.type === "tool_result") map.set(block.tool_use_id, block)
    }
  }
  return map
}

/** One SDK content block of an assistant message, SDK fields straight to glyphs. */
function SdkBlockView(props: {
  block: SdkContentBlock
  result?: SdkToolResultBlock
  /** Subagent step (parent_tool_use_id set) — indented under its Agent row. */
  nested: boolean
  expanded: boolean
}) {
  const { theme } = useTheme()
  const block = props.block
  return (
    <Switch>
      <Match when={block.type === "text" && block}>
        {(b) => (
          <text fg={theme.text} wrapMode="word">
            {b().text}
          </text>
        )}
      </Match>
      <Match when={block.type === "thinking" && block}>
        {(b) => (
          <box flexDirection="column">
            <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
              {`✱ ${t("chat.thinking")}${props.expanded ? "" : "…"}`}
            </text>
            <Show when={props.expanded && b().thinking.trim()}>
              <BodyLines text={b().thinking} />
            </Show>
          </box>
        )}
      </Match>
      <Match when={block.type === "tool_use" && block}>
        {(b) => {
          const ok = () => !props.result?.is_error
          const summary = () => toolInputSummary(b().input)
          const body = () => (props.result ? bodyText(props.result.content) : "")
          return (
            <box flexDirection="column" paddingLeft={props.nested ? 2 : 0}>
              <box flexDirection="row" gap={1}>
                <text fg={props.result ? (ok() ? theme.success : theme.error) : theme.textMuted} wrapMode="none">
                  ⏺
                </text>
                <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
                  {b().name}
                </text>
                <Show when={summary()}>
                  <text fg={theme.textMuted} wrapMode="none">
                    {summary()}
                  </text>
                </Show>
              </box>
              <Show when={props.expanded && body().trim()}>
                <BodyLines text={body()} error={props.result?.is_error} />
              </Show>
            </box>
          )
        }}
      </Match>
    </Switch>
  )
}

/** One transcript row. SDK `user` (tool results) and `system` rows render nothing —
 *  results attach to their tool_use row; init only feeds the resume session id. */
function ChatRow(props: { item: ChatItem; results: Map<string, SdkToolResultBlock>; expanded: boolean }) {
  const { theme } = useTheme()
  const item = props.item
  if (item.kind === "prompt") {
    return (
      <box
        flexDirection="row"
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        marginBottom={1}
        backgroundColor={theme.backgroundElement}
      >
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          ❯
        </text>
        <text fg={theme.text} wrapMode="word" flexGrow={1}>
          {item.text}
        </text>
      </box>
    )
  }
  if (item.kind === "error") {
    return (
      <text fg={theme.error} wrapMode="word">
        {`${t("chat.errorPrefix")}: ${item.text}`}
      </text>
    )
  }
  const msg = item.msg
  if (msg.type === "assistant") {
    const nested = msg.parent_tool_use_id != null
    // Subagent prose stays internal — only its tool steps surface (same rule
    // the v0.5 stream parser applied): nested rows keep tool_use blocks only.
    const blocks = msg.message.content.filter((b) => !nested || b.type === "tool_use")
    return (
      <box flexDirection="column" marginBottom={blocks.some((b) => b.type === "text") ? 1 : 0}>
        <For each={blocks}>
          {(block) => (
            <SdkBlockView
              block={block}
              result={block.type === "tool_use" ? props.results.get(block.id) : undefined}
              nested={nested}
              expanded={props.expanded}
            />
          )}
        </For>
      </box>
    )
  }
  if (msg.type === "result") {
    // SDK result fields verbatim: duration_ms · output_tokens · total_cost_usd.
    if (msg.is_error) {
      const detail = typeof msg.result === "string" && msg.result.trim() ? msg.result.trim() : msg.subtype
      return (
        <text fg={theme.error} wrapMode="word">
          {`${t("chat.errorPrefix")}: ${detail}`}
        </text>
      )
    }
    const parts: string[] = []
    if (typeof msg.duration_ms === "number") parts.push(`${(msg.duration_ms / 1000).toFixed(1)}s`)
    if (typeof msg.usage?.output_tokens === "number") parts.push(`${msg.usage.output_tokens} tok`)
    if (typeof msg.total_cost_usd === "number") parts.push(`$${msg.total_cost_usd.toFixed(4)}`)
    return (
      <Show when={parts.length > 0}>
        <text fg={theme.textMuted} wrapMode="none" marginBottom={1}>
          {`· ${parts.join(" · ")}`}
        </text>
      </Show>
    )
  }
  return null
}

function ChatScreen(props: ChatHostArgs) {
  const { theme } = useTheme()
  const [items, setItems] = createSignal<readonly ChatItem[]>([])
  const [running, setRunning] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [expanded, setExpanded] = createSignal(false)
  const results = createMemo(() => sdkResultsByToolUseId(items()))

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
      const turn = startHeadlessTurn({
        binaryPath,
        cwd: props.worktree,
        prompt,
        resumeSessionId,
        permissionMode: props.permissionMode,
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
    }
  }

  function submit(): void {
    const prompt = draft().trim()
    if (!prompt || running()) return
    setDraft("")
    void runTurn(prompt)
  }

  let scrollRef: ScrollBoxRenderable | undefined
  const scrollBy = (dy: number): void => {
    if (!scrollRef) return
    scrollRef.scrollTo({ x: 0, y: Math.max(0, scrollRef.scrollTop + dy) })
  }

  useBindings(() => ({
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
          <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
            <For each={items()}>{(item) => <ChatRow item={item} results={results()} expanded={expanded()} />}</For>
          </box>
        </Show>
      </scrollbox>
      {/* Composer — always focused; enter submits, disabled while running. */}
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={running() ? theme.textMuted : theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          ❯
        </text>
        <input
          value={draft()}
          placeholder={t("chat.placeholder")}
          focused={true}
          onInput={(v: string) => setDraft(v)}
          onSubmit={() => submit()}
        />
      </box>
      <box paddingLeft={1} paddingRight={1} flexShrink={0} backgroundColor={theme.backgroundElement}>
        <text fg={theme.textMuted} wrapMode="none">
          {running() ? t("chat.hintRunning") : t("chat.hint")}
        </text>
      </box>
    </box>
  )
}

export async function startChatHost(args: ChatHostArgs): Promise<void> {
  await bootPaneHost({
    logContext: "chat",
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <ChatScreen {...args} /> }),
  })
}
