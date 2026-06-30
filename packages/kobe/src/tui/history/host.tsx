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
 * Runs in its own OS process inside the tmux pane (separate opentui render loop),
 * the same standalone-pane shape as `kobe ops` — see `tui/ops/host.tsx`. Pure
 * read surface: no engine spawn, no write path, no daemon dependency.
 */

import { engineEntry } from "@/engine/registry"
import type { ContentBlock } from "@/types/content"
import type { Message } from "@/types/engine"
import type { VendorId } from "@/types/task"
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createResource, createSignal, on } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"

export interface HistoryHostArgs {
  readonly worktree: string
  readonly vendor: VendorId
  /** Optional task title for the header; falls back to the worktree basename. */
  readonly title?: string
}

/** Lines of transcript scrolled per `j`/`k` keypress. */
const SCROLL_STEP = 3
/** One-line cap for a tool call's input / result summary. */
const SUMMARY_MAX = 200

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

/** Collapse arbitrary vendor-shaped tool data to one truncated line. */
function summarize(value: unknown): string {
  let text: string
  if (typeof value === "string") text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX)}…` : oneLine
}

function BlockView(props: { block: ContentBlock }) {
  const { theme } = useTheme()
  const block = props.block
  switch (block.type) {
    case "text":
      return (
        <text fg={theme.text} wrapMode="word">
          {block.text}
        </text>
      )
    case "thinking":
      return (
        <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="word">
          {`✻ ${t("history.thinking")} ${block.text}`}
        </text>
      )
    case "tool_call":
      return (
        <text fg={theme.info} wrapMode="word">
          {`⚙ ${block.name}${block.input == null ? "" : ` ${summarize(block.input)}`}`}
        </text>
      )
    case "tool_result":
      return (
        <text fg={block.isError ? theme.error : theme.textMuted} wrapMode="word">
          {`↳ ${summarize(block.output)}`}
        </text>
      )
  }
}

function roleLabel(role: Message["role"]): string {
  return role === "assistant"
    ? t("history.role.assistant")
    : role === "system"
      ? t("history.role.system")
      : t("history.role.user")
}

function MessageView(props: { msg: Message }) {
  const { theme } = useTheme()
  const role = () => props.msg.role
  const roleColor = () =>
    role() === "assistant" ? theme.primary : role() === "system" ? theme.textMuted : theme.accent
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} gap={0}>
      <text fg={roleColor()} attributes={TextAttributes.BOLD} wrapMode="none">
        {`▌ ${roleLabel(props.msg.role)}`}
      </text>
      <For each={props.msg.blocks}>{(block) => <BlockView block={block} />}</For>
    </box>
  )
}

function HistoryScreen(props: HistoryHostArgs) {
  const { theme } = useTheme()

  // Session ids for the worktree, oldest-first (reader contract). Swallow
  // errors → empty list (best-effort read surface).
  const [sessions] = createResource(
    () => props.worktree,
    async (wt): Promise<readonly string[]> => {
      try {
        return await engineEntry(props.vendor).history.listSessionIdsForWorktree(wt)
      } catch {
        return []
      }
    },
  )
  const sessionList = (): readonly string[] => sessions() ?? []

  // Default the selection to the NEWEST session (last, since oldest-first) and
  // re-clamp whenever the list (re)loads.
  const [selected, setSelected] = createSignal(0)
  createEffect(
    on(sessions, (s) => {
      const n = (s ?? []).length
      setSelected(n > 0 ? n - 1 : 0)
    }),
  )
  const selectedId = (): string | undefined => sessionList()[selected()]

  const [messages] = createResource(
    () => selectedId(),
    async (id): Promise<Message[]> => {
      if (!id) return []
      try {
        return await engineEntry(props.vendor).history.readHistory(id)
      } catch {
        return []
      }
    },
  )
  const messageList = (): Message[] => messages() ?? []

  let scrollRef: ScrollBoxRenderable | undefined
  const scrollBy = (dy: number): void => {
    if (!scrollRef) return
    scrollRef.scrollTo({ x: 0, y: Math.max(0, scrollRef.scrollTop + dy) })
  }
  // Jump back to the top when switching to a different session.
  createEffect(on(selectedId, () => scrollRef?.scrollTo({ x: 0, y: 0 })))

  const switchSession = (delta: number): void => {
    const n = sessionList().length
    if (n === 0) return
    setSelected((i) => Math.min(Math.max(i + delta, 0), n - 1))
  }

  useBindings(() => ({
    bindings: [
      { key: "q", cmd: () => process.exit(0) },
      { key: "escape", cmd: () => process.exit(0) },
      { key: "ctrl+c", cmd: () => process.exit(0) },
      { key: "j", cmd: () => scrollBy(SCROLL_STEP) },
      { key: "k", cmd: () => scrollBy(-SCROLL_STEP) },
      { key: "down", cmd: () => scrollBy(SCROLL_STEP) },
      { key: "up", cmd: () => scrollBy(-SCROLL_STEP) },
      { key: "[", cmd: () => switchSession(-1) },
      { key: "]", cmd: () => switchSession(1) },
    ],
  }))

  const headerTitle = (): string => props.title?.trim() || basename(props.worktree)
  const counter = (): string => {
    const n = sessionList().length
    return n > 0 ? `${t("history.sessionLabel")} ${selected() + 1}/${n}` : ""
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
          {t("history.archivedTag")}
        </text>
        <text fg={theme.accent} wrapMode="none">
          {headerTitle()}
        </text>
        <Show when={counter()}>
          <text fg={theme.textMuted} wrapMode="none">
            {counter()}
          </text>
        </Show>
        <box flexGrow={1} />
        <text fg={theme.textMuted} wrapMode="none">
          {t("history.hint")}
        </text>
      </box>
      <scrollbox
        ref={(r: ScrollBoxRenderable) => {
          scrollRef = r
        }}
        flexGrow={1}
        verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
      >
        <Show
          when={!sessions.loading && !messages.loading}
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
            <For each={messageList()}>{(msg) => <MessageView msg={msg} />}</For>
          </Show>
        </Show>
      </scrollbox>
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
