/**
 * `kobe history` host — a read-only engine-history preview pane (beta).
 *
 * When an ARCHIVED task is opened with the `experimental.archivedHistoryPreview`
 * gate on, the session-build (panes/terminal/tmux.ts) launches THIS process into
 * the engine pane slot INSTEAD of the live engine CLI — so the "vendor pane" you
 * normally chat in is replaced by a scrollable transcript with a session
 * selector. An archived task usually has no running engine (and may have no
 * worktree at all), but its transcript still lives in the engine's vendor store
 * keyed by the worktree PATH STRING (claude `~/.claude/projects/*`, codex
 * `~/.codex/sessions/**`), which `git worktree remove` never touched. We read it
 * through the neutral `EngineHistoryReader` (engine/registry.ts), so no vendor
 * transcript format leaks into this UI (CLAUDE.md: engine-owned UI data).
 *
 * The visual mirrors the web ChatTranscript (kobe's own sibling surface): user
 * turns are tinted cards with a `❯` glyph + relative-time chip, assistant text is
 * plain, tool calls are a colored `⏺` status glyph + bold name + dim summary, and
 * `enter` expands the tool-output / thinking bodies. Runs in its own OS process
 * inside the tmux pane (separate opentui render loop), the same standalone-pane
 * shape as `kobe ops` — see `tui/ops/host.tsx`. Pure read surface: no engine
 * spawn, no write path, no daemon dependency.
 */

import { type EngineHistoryReader, engineEntry } from "@/engine/registry"
import type { ContentBlock } from "@/types/content"
import type { Message } from "@/types/engine"
import type { VendorId } from "@/types/task"
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { ACTIVITY_POLL_MIN_MS, nextActivityPollDelay } from "../ops/activity-poll"

export interface HistoryHostArgs {
  readonly worktree: string
  readonly vendor: VendorId
  /** Optional task title for the header; falls back to the worktree basename. */
  readonly title?: string
  /**
   * Live preview of a non-archived task (vs the frozen archived transcript):
   * the header tags LIVE instead of ARCHIVED. The mtime poll runs either way;
   * this only picks the badge.
   */
  readonly live?: boolean
  /**
   * Override the transcript source. Production leaves it undefined (reads the
   * real engine store via {@link engineEntry}); the dev:mock host injects a
   * fake reader so the whole pane renders without a real worktree/transcript.
   */
  readonly reader?: EngineHistoryReader
}

/** Lines of transcript scrolled per `j`/`k` keypress. */
const SCROLL_STEP = 3
/** One-line cap for a tool call's input summary. */
const SUMMARY_MAX = 120

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

/** Relative age of an ISO timestamp ("3m", "2h", "4d"), or "" when unparseable. */
function relativeTime(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ""
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * One-line label for a tool call — ported from the web `tool-display.ts` so the
 * two surfaces read identically (don't reinvent). Picks the most meaningful
 * string field by priority (command → file_path → pattern → url → description →
 * prompt → query) so a Bash call reads as its command and a Read as its path,
 * not a raw JSON blob; falls back to compact JSON, truncated.
 */
function toolInputSummary(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>
    const pick = (key: string): string | null => (typeof obj[key] === "string" ? (obj[key] as string) : null)
    const candidate =
      pick("command") ??
      pick("file_path") ??
      pick("pattern") ??
      pick("url") ??
      pick("description") ??
      pick("prompt") ??
      pick("query")
    if (candidate) return candidate.length > SUMMARY_MAX ? `${candidate.slice(0, SUMMARY_MAX - 1)}…` : candidate
  }
  try {
    const raw = JSON.stringify(input)
    if (!raw || raw === "{}" || raw === "null") return ""
    return raw.length > SUMMARY_MAX ? `${raw.slice(0, SUMMARY_MAX - 1)}…` : raw
  } catch {
    return ""
  }
}

/** Full multi-line stringification of a tool result, for the expanded body. */
function bodyText(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Index tool_result blocks by their callId so a tool_call can show its result. */
function resultsByCallId(messages: readonly Message[]): Map<string, Extract<ContentBlock, { type: "tool_result" }>> {
  const map = new Map<string, Extract<ContentBlock, { type: "tool_result" }>>()
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === "tool_result") map.set(b.callId, b)
    }
  }
  return map
}

/** A tool-output / thinking body, one `<text>` per line so +/- diff lines tint. */
function BodyLines(props: { text: string; error?: boolean }) {
  const { theme } = useTheme()
  const lines = () => props.text.replace(/\s+$/, "").split("\n")
  const lineColor = (line: string) => {
    if (props.error) return theme.error
    if (line.startsWith("+") && !line.startsWith("+++")) return theme.success
    if (line.startsWith("-") && !line.startsWith("---")) return theme.error
    return theme.textMuted
  }
  return (
    <box flexDirection="column" paddingLeft={2} marginLeft={2} backgroundColor={theme.backgroundElement}>
      <For each={lines()}>
        {(line) => (
          <text fg={lineColor(line)} wrapMode="word">
            {line || " "}
          </text>
        )}
      </For>
    </box>
  )
}

function BlockView(props: {
  block: ContentBlock
  result?: Extract<ContentBlock, { type: "tool_result" }>
  expanded: boolean
}) {
  const { theme } = useTheme()
  const block = props.block
  switch (block.type) {
    case "text":
      // user-text is rendered as a card by MessageCard; this path is assistant/system.
      return (
        <text fg={theme.text} wrapMode="word">
          {block.text}
        </text>
      )
    case "thinking":
      return (
        <box flexDirection="column">
          <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
            {`✱ ${t("history.thinking")}${props.expanded ? "" : "…"}`}
          </text>
          <Show when={props.expanded && block.text.trim()}>
            <BodyLines text={block.text} />
          </Show>
        </box>
      )
    case "tool_call": {
      const ok = !props.result?.isError
      const body = props.result ? bodyText(props.result.output) : ""
      const summary = toolInputSummary(block.input)
      return (
        <box flexDirection="column">
          <box flexDirection="row" gap={1}>
            <text fg={ok ? theme.success : theme.error} wrapMode="none">
              ⏺
            </text>
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
              {block.name}
            </text>
            <Show when={summary}>
              <text fg={theme.textMuted} wrapMode="none">
                {summary}
              </text>
            </Show>
          </box>
          <Show when={props.expanded && body.trim()}>
            <BodyLines text={body} error={props.result?.isError} />
          </Show>
        </box>
      )
    }
    case "tool_result":
      // Attached to its tool_call above — never rendered standalone.
      return null
  }
}

function roleLabel(role: Message["role"]): string {
  return role === "assistant"
    ? t("history.role.assistant")
    : role === "system"
      ? t("history.role.system")
      : t("history.role.user")
}

function MessageCard(props: {
  msg: Message
  results: Map<string, Extract<ContentBlock, { type: "tool_result" }>>
  expanded: boolean
}) {
  const { theme } = useTheme()
  const isUser = () => props.msg.role === "user"
  const stamp = () => relativeTime(props.msg.timestamp)
  // user text blocks → a tinted card with a ❯ glyph + time chip; everything
  // else (assistant/system text, tools, thinking) renders flush below.
  const userText = createMemo(() =>
    isUser()
      ? props.msg.blocks
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text" && b.text.trim().length > 0)
          .map((b) => b.text)
          .join("\n")
      : "",
  )
  const otherBlocks = () => (isUser() ? props.msg.blocks.filter((b) => b.type !== "text") : props.msg.blocks)
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} gap={0}>
      <Show when={isUser() && userText()}>
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundElement}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
            ❯
          </text>
          <text fg={theme.text} wrapMode="word" flexGrow={1}>
            {userText()}
          </text>
          <Show when={stamp()}>
            <text fg={theme.textMuted} wrapMode="none">
              {stamp()}
            </text>
          </Show>
        </box>
      </Show>
      <Show when={!isUser()}>
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
          {roleLabel(props.msg.role)}
        </text>
      </Show>
      <For each={otherBlocks()}>
        {(block) => (
          <BlockView
            block={block}
            result={block.type === "tool_call" ? props.results.get(block.callId) : undefined}
            expanded={props.expanded}
          />
        )}
      </For>
    </box>
  )
}

function HistoryScreen(props: HistoryHostArgs) {
  const { theme } = useTheme()
  // Data source: the injected reader (dev:mock) or the real engine transcript
  // store. All three reads below go through it so a mock drives the whole pane.
  const reader = props.reader ?? engineEntry(props.vendor).history

  // Live refresh: poll the vendor transcript mtime (adaptive backoff, shared
  // with the Ops pane) and bump this tick when it advances so the resources
  // below refetch. An archived task whose transcript never changes ramps the
  // backoff to its cap — effectively idle — so the same host serves both the
  // static archived preview and a live follow of an active worktree.
  const [refreshTick, setRefreshTick] = createSignal(0)

  const [sessions] = createResource(
    () => [props.worktree, refreshTick()] as const,
    async ([wt]): Promise<readonly string[]> => {
      try {
        return await reader.listSessionIdsForWorktree(wt)
      } catch {
        return []
      }
    },
  )
  // `.latest` keeps the last resolved list visible while a refresh refetch is in
  // flight, so a live tick doesn't blink the pane back to its loading state.
  const sessionList = (): readonly string[] => sessions.latest ?? []

  const [selected, setSelected] = createSignal(0)
  // Follow the newest session when a NEW one appears (or on first load), but
  // leave the cursor alone on a same-count refresh so a user browsing an older
  // session with `[`/`]` isn't yanked back to the tail every poll.
  let prevSessionCount = 0
  createEffect(
    on(sessions, (s) => {
      const n = (s ?? []).length
      if (n > prevSessionCount) setSelected(n > 0 ? n - 1 : 0)
      else setSelected((i) => Math.min(i, Math.max(0, n - 1)))
      prevSessionCount = n
    }),
  )
  const selectedId = (): string | undefined => sessionList()[selected()]

  const [messages] = createResource(
    () => {
      const id = selectedId()
      return id ? ([id, refreshTick()] as const) : undefined
    },
    async ([id]): Promise<Message[]> => {
      try {
        return await reader.readHistory(id)
      } catch {
        return []
      }
    },
  )
  const messageList = (): Message[] => messages.latest ?? []
  const results = createMemo(() => resultsByCallId(messageList()))
  const tokenTotal = createMemo(() => messageList().reduce((sum, m) => sum + (m.usage?.output_tokens ?? 0), 0))

  const [expanded, setExpanded] = createSignal(false)

  // Drive refreshTick from the transcript mtime. The first read only seeds the
  // baseline (the resources already fetched once on mount); after that a tick
  // fires only when the mtime advances. On an archived / idle worktree the
  // delay ramps to the cap so this isn't a stat-churn loop.
  onMount(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let delayMs = ACTIVITY_POLL_MIN_MS
    let idleStreak = 0
    let lastMtime = 0
    let primed = false
    async function poll(): Promise<void> {
      try {
        const mtime = await reader.latestTranscriptMtimeForWorktree(props.worktree)
        if (disposed) return
        if (!primed) {
          primed = true
          lastMtime = mtime
          idleStreak++
        } else if (mtime > lastMtime) {
          lastMtime = mtime
          idleStreak = 0
          setRefreshTick((n) => n + 1)
        } else {
          idleStreak++
        }
      } catch {
        // The worktree can vanish under a live pane (task deletion); a transient
        // read failure must not crash this daemon-less process — swallow and let
        // the idle ramp keep climbing.
        idleStreak++
      } finally {
        if (!disposed) {
          delayMs = nextActivityPollDelay(delayMs, idleStreak)
          timer = setTimeout(() => void poll(), delayMs)
        }
      }
    }
    void poll()
    onCleanup(() => {
      disposed = true
      if (timer) clearTimeout(timer)
    })
  })

  let scrollRef: ScrollBoxRenderable | undefined
  const scrollBy = (dy: number): void => {
    if (!scrollRef) return
    scrollRef.scrollTo({ x: 0, y: Math.max(0, scrollRef.scrollTop + dy) })
  }
  createEffect(on(selectedId, () => scrollRef?.scrollTo({ x: 0, y: 0 })))

  const switchSession = (delta: number): void => {
    const n = sessionList().length
    if (n === 0) return
    setSelected((i) => Math.min(Math.max(i + delta, 0), n - 1))
  }

  // No self-close binding: this read-only preview replaces the engine pane of an
  // ARCHIVED task. Its pane re-launches it on exit (historyPaneKeepAlive), so a
  // quit would just reload the preview — and the original behavior was worse: it
  // dropped to a shell that, on exit, spawned a live engine via engine-tab-exit.
  // The preview is left like any other pane — the Tasks rail or Ctrl+Q.
  useBindings(() => ({
    bindings: [
      { key: "j", cmd: () => scrollBy(SCROLL_STEP) },
      { key: "k", cmd: () => scrollBy(-SCROLL_STEP) },
      { key: "down", cmd: () => scrollBy(SCROLL_STEP) },
      { key: "up", cmd: () => scrollBy(-SCROLL_STEP) },
      { key: "[", cmd: () => switchSession(-1) },
      { key: "]", cmd: () => switchSession(1) },
      { key: "return", cmd: () => setExpanded((e) => !e) },
    ],
  }))

  const headerTitle = (): string => props.title?.trim() || basename(props.worktree)
  const counter = (): string => {
    const n = sessionList().length
    return n > 0 ? `${t("history.sessionLabel")} ${selected() + 1}/${n}` : ""
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      {/* Brand header — ARCHIVED tag · title · session N/M · token total. */}
      <box
        flexDirection="row"
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        backgroundColor={theme.backgroundElement}
      >
        <text fg={props.live ? theme.success : theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
          {props.live ? t("history.liveTag") : t("history.archivedTag")}
        </text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
          {headerTitle()}
        </text>
        <Show when={counter()}>
          <text fg={theme.textMuted} wrapMode="none">
            {`· ${counter()}`}
          </text>
        </Show>
        <box flexGrow={1} />
        <Show when={tokenTotal() > 0}>
          <text fg={theme.textMuted} wrapMode="none">
            {`${tokenTotal()} tok`}
          </text>
        </Show>
      </box>
      <scrollbox
        ref={(r: ScrollBoxRenderable) => {
          scrollRef = r
        }}
        flexGrow={1}
        verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
      >
        <Show
          when={sessions.latest !== undefined}
          fallback={
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted}>{t("history.loading")}</text>
            </box>
          }
        >
          <Show
            when={messageList().length > 0}
            fallback={
              <box paddingTop={1} paddingLeft={1}>
                <text fg={theme.textMuted}>{t("history.empty")}</text>
              </box>
            }
          >
            <For each={messageList()}>
              {(msg) => <MessageCard msg={msg} results={results()} expanded={expanded()} />}
            </For>
          </Show>
        </Show>
      </scrollbox>
      {/* Hint bar. */}
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        backgroundColor={theme.backgroundElement}
      >
        <text fg={theme.textMuted} wrapMode="none">
          {expanded() ? t("history.hintExpanded") : t("history.hint")}
        </text>
      </box>
    </box>
  )
}

export async function startHistoryHost(args: HistoryHostArgs): Promise<void> {
  // Minimal provider set, same as the Ops pane: this surface never touches
  // persisted UI state or pane focus — Theme + Dialog only (host-boot still
  // applies theme/locale from state.json at boot + live ui-prefs pushes).
  await bootPaneHost({
    logContext: "history",
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <HistoryScreen {...args} /> }),
  })
}
