/** @jsxImportSource @opentui/react */
/**
 * React `kobe history` host — G3.1's first real pane port.
 *
 * Async pattern canon for later React panes: each async read is modeled with
 * `useState` plus a dependency-keyed `useEffect`. The effect keeps the last
 * resolved value visible while a refresh is in flight, catches read failures to
 * an empty value at the reader boundary, and cancels stale promise completions
 * with an effect-local `disposed` flag. Live transcript mtime polling is a
 * separate effect that bumps `refreshTick`; the data effects refetch from that
 * scalar instead of owning their own timers.
 */

import { type EngineHistoryReader, engineEntry } from "@/engine/registry"
import type { Message } from "@/types/engine"
import type { VendorId } from "@/types/task"
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { resultsByCallId } from "../../tui/history/message-core"
import { windowTail } from "../../tui/history/window"
import { sessionAttached } from "../../tui/lib/attach-gate"
import { ACTIVITY_POLL_MIN_MS, nextActivityPollDelay } from "../../tui/ops/activity-poll"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { MessageCard } from "./message-card"

export interface HistoryHostArgs {
  readonly worktree: string
  readonly vendor: VendorId
  /** Optional task title for the header; falls back to the worktree basename. */
  readonly title?: string
  /** Live preview of a non-archived task (vs the frozen archived transcript). */
  readonly live?: boolean
  /** Override the transcript source; dev:mock injects a fake reader. */
  readonly reader?: EngineHistoryReader
}

/** Lines of transcript scrolled per `j`/`k` keypress. */
const SCROLL_STEP = 3

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

function HistoryScreen(props: HistoryHostArgs) {
  const { theme } = useTheme()
  const t = useT()
  const reader = useMemo(() => props.reader ?? engineEntry(props.vendor).history, [props.reader, props.vendor])
  const [refreshTick, setRefreshTick] = useState(0)
  const [sessions, setSessions] = useState<readonly string[] | undefined>(undefined)
  const [selected, setSelected] = useState(0)
  const [messages, setMessages] = useState<Message[] | undefined>(undefined)
  const [expanded, setExpanded] = useState(false)
  const prevSessionCount = useRef(0)
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  useEffect(() => {
    // Dependency-only invalidation key: the reader API takes worktree, while
    // refreshTick tells this effect when the mtime poll saw new transcript data.
    void refreshTick
    let disposed = false
    void reader
      .listSessionIdsForWorktree(props.worktree)
      .then((list) => {
        if (!disposed) setSessions(list)
      })
      .catch(() => {
        if (!disposed) setSessions([])
      })
    return () => {
      disposed = true
    }
  }, [reader, props.worktree, refreshTick])

  const sessionList = sessions ?? []
  useEffect(() => {
    if (sessions === undefined) return
    const n = sessions.length
    setSelected((i) => (n > prevSessionCount.current ? (n > 0 ? n - 1 : 0) : Math.min(i, Math.max(0, n - 1))))
    prevSessionCount.current = n
  }, [sessions])

  const selectedId = sessionList[selected]
  useEffect(() => {
    // Dependency-only invalidation key; readHistory itself is session-id based.
    void refreshTick
    if (!selectedId) {
      setMessages([])
      return
    }
    let disposed = false
    void reader
      .readHistory(selectedId)
      .then((list) => {
        if (!disposed) setMessages(list)
      })
      .catch(() => {
        if (!disposed) setMessages([])
      })
    return () => {
      disposed = true
    }
  }, [reader, selectedId, refreshTick])

  const messageList = messages ?? []
  const results = useMemo(() => resultsByCallId(messageList), [messageList])
  const tokenTotal = useMemo(
    () => messageList.reduce((sum, m) => sum + (m.usage?.output_tokens ?? 0), 0),
    [messageList],
  )
  const tail = useMemo(() => windowTail(messageList), [messageList])

  useEffect(() => {
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
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [reader, props.worktree])

  const scrollBy = useCallback((dy: number): void => {
    const scroll = scrollRef.current
    if (!scroll) return
    scroll.scrollTo({ x: 0, y: Math.max(0, scroll.scrollTop + dy) })
  }, [])
  useEffect(() => {
    // Dependency-only reset key: scroll to top whenever the selected session changes.
    void selectedId
    scrollRef.current?.scrollTo({ x: 0, y: 0 })
  }, [selectedId])

  const switchSession = useCallback(
    (delta: number): void => {
      const n = sessionList.length
      if (n === 0) return
      setSelected((i) => Math.min(Math.max(i + delta, 0), n - 1))
    },
    [sessionList.length],
  )

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

  const headerTitle = props.title?.trim() || basename(props.worktree)
  const counter = sessionList.length > 0 ? `${t("history.sessionLabel")} ${selected + 1}/${sessionList.length}` : ""

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
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
          {headerTitle}
        </text>
        {counter ? (
          <text fg={theme.textMuted} wrapMode="none">
            {`· ${counter}`}
          </text>
        ) : null}
        <box flexGrow={1} />
        {tokenTotal > 0 ? (
          <text fg={theme.textMuted} wrapMode="none">
            {`${tokenTotal} tok`}
          </text>
        ) : null}
      </box>
      <scrollbox
        ref={(r: ScrollBoxRenderable | null) => {
          scrollRef.current = r
        }}
        flexGrow={1}
        verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
      >
        {sessions === undefined ? (
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>{t("history.loading")}</text>
          </box>
        ) : messageList.length > 0 ? (
          <>
            {tail.hiddenCount > 0 ? (
              <box paddingLeft={1} paddingRight={1} paddingBottom={1}>
                <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
                  {t("history.earlier", { count: tail.hiddenCount })}
                </text>
              </box>
            ) : null}
            {tail.visible.map((msg, i) => (
              <MessageCard
                key={`${msg.sessionId}:${msg.timestamp}:${i}`}
                msg={msg}
                results={results}
                expanded={expanded}
              />
            ))}
          </>
        ) : (
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>{t("history.empty")}</text>
          </box>
        )}
      </scrollbox>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        backgroundColor={theme.backgroundElement}
      >
        <text fg={theme.textMuted} wrapMode="none">
          {expanded ? t("history.hintExpanded") : t("history.hint")}
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
