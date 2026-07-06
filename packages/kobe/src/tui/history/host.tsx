import { type EngineHistoryReader, engineEntry } from "@/engine/registry"
import type { Message } from "@/types/engine"
import type { VendorId } from "@/types/task"
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { sessionAttached } from "../lib/attach-gate"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { ACTIVITY_POLL_MIN_MS, nextActivityPollDelay } from "../ops/activity-poll"
import { MessageCard, resultsByCallId } from "./message-card"
import { windowTail } from "./window"

export { BodyLines, bodyText, toolInputSummary } from "./message-card"

export interface HistoryHostArgs {
  readonly worktree: string
  readonly vendor: VendorId
  readonly title?: string
  readonly live?: boolean
  readonly reader?: EngineHistoryReader
}

const SCROLL_STEP = 3

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

function HistoryScreen(props: HistoryHostArgs) {
  const { theme } = useTheme()
  const reader = props.reader ?? engineEntry(props.vendor).history

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
  const sessionList = (): readonly string[] => sessions.latest ?? []

  const [selected, setSelected] = createSignal(0)
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
  const tail = createMemo(() => windowTail(messageList()))

  const [expanded, setExpanded] = createSignal(false)

  onMount(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let delayMs = ACTIVITY_POLL_MIN_MS
    let idleStreak = 0
    let lastMtime = 0
    let primed = false
    async function poll(): Promise<void> {
      if (!(await sessionAttached())) {
        if (!disposed) timer = setTimeout(() => void poll(), delayMs)
        return
      }
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
      {}
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
            <Show when={tail().hiddenCount > 0}>
              <box paddingLeft={1} paddingRight={1} paddingBottom={1}>
                <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
                  {t("history.earlier", { count: tail().hiddenCount })}
                </text>
              </box>
            </Show>
            <For each={tail().visible}>
              {(msg) => <MessageCard msg={msg} results={results()} expanded={expanded()} />}
            </For>
          </Show>
        </Show>
      </scrollbox>
      {}
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
  await bootPaneHost({
    logContext: "history",
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <HistoryScreen {...args} /> }),
  })
}
