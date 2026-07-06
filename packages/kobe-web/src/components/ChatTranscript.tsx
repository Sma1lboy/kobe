import { ChevronDown, ChevronRight, RotateCw, Search, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type ContentBlock,
  fetchMessages,
  fetchSessions,
  formatTokens,
  type HistoryMessage,
  summarizeUsage,
} from "../lib/history.ts"
import { isNearBottom } from "../lib/scroll.ts"
import { useAppState } from "../lib/store.ts"
import { relativeTime } from "../lib/time.ts"
import { outputText, toolInputSummary } from "../lib/tool-display.ts"
import {
  blockVisible,
  messageRendersAnything,
  messageSearchText,
} from "../lib/transcript-search.ts"
import { isWebTransportOffline } from "../lib/web-transport.ts"

const POLL_MS = 2_500
const OUTPUT_PREVIEW_CHARS = 600

type ToolResult = Extract<ContentBlock, { type: "tool_result" }>
type ToolCall = Extract<ContentBlock, { type: "tool_call" }>

function ToolRow({
  call,
  result,
}: {
  call: ToolCall
  result: ToolResult | undefined
}) {
  const [open, setOpen] = useState(false)
  const summary = toolInputSummary(call)
  const body = result ? outputText(result.output) : ""
  const truncated = !open && body.length > OUTPUT_PREVIEW_CHARS
  const shown = truncated ? `${body.slice(0, OUTPUT_PREVIEW_CHARS)}…` : body
  const expandable = body.length > 0
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => expandable && setOpen((cur) => !cur)}
        className={`flex w-full items-baseline gap-2 text-left ${expandable ? "cursor-pointer" : "cursor-default"}`}
      >
        <span
          className={`shrink-0 text-[11px] ${result?.isError ? "text-kobe-red" : "text-kobe-green"}`}
        >
          ⏺
        </span>
        <span className="shrink-0 text-[12px] font-semibold text-fg">
          {call.name}
        </span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle">
            {summary}
          </span>
        )}
        {expandable && (
          <span className="shrink-0 text-subtle">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>
      {(open || (!open && body && body.length <= OUTPUT_PREVIEW_CHARS)) &&
        body && (
          <pre
            className={`mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words border-l-2 pl-3 font-mono text-[11px] leading-relaxed ${
              result?.isError
                ? "border-kobe-red/40 text-kobe-red/90"
                : "border-line text-muted"
            }`}
          >
            {shown}
          </pre>
        )}
      {truncated && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="ml-5 mt-0.5 text-[10px] text-subtle hover:text-fg"
        >
          show full output
        </button>
      )}
    </div>
  )
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((cur) => !cur)}
        className="flex items-baseline gap-2 text-[11px] italic text-subtle hover:text-muted"
      >
        <span>✱</span>
        <span>{open ? "thinking" : "thinking…"}</span>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </button>
      {open && (
        <p className="mt-1 whitespace-pre-wrap break-words border-l-2 border-line-subtle pl-3 text-[11px] italic leading-relaxed text-subtle">
          {text}
        </p>
      )}
    </div>
  )
}

function MessageRow({
  message,
  results,
  hideTools,
}: {
  message: HistoryMessage
  results: ReadonlyMap<string, ToolResult>
  hideTools: boolean
}) {
  const rows: React.ReactNode[] = []
  const stamp = relativeTime(message.timestamp)
  let stamped = false
  message.blocks.forEach((block, index) => {
    if (!blockVisible(block, hideTools)) return
    const key = `${message.timestamp}-${index}`
    if (block.type === "text") {
      if (!block.text.trim()) return
      if (message.role === "user") {
        rows.push(
          <div
            key={key}
            className="my-2 flex items-baseline gap-2 border-l-2 border-primary/60 bg-inset/40 px-3 py-2"
          >
            <span className="shrink-0 font-mono text-[12px] font-bold text-primary">
              ❯
            </span>
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg">
              {block.text}
            </p>
            {stamp && !stamped && (
              <span
                className="shrink-0 font-mono text-[10px] text-subtle"
                title={message.timestamp}
              >
                {stamp}
              </span>
            )}
          </div>,
        )
        stamped = true
      } else {
        rows.push(
          <p
            key={key}
            className={`my-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed ${
              message.role === "system" ? "text-subtle" : "text-fg/90"
            }`}
          >
            {block.text}
          </p>,
        )
      }
      return
    }
    if (block.type === "tool_call") {
      rows.push(
        <ToolRow key={key} call={block} result={results.get(block.callId)} />,
      )
      return
    }
    if (block.type === "thinking") {
      if (block.text.trim())
        rows.push(<ThinkingRow key={key} text={block.text} />)
      return
    }
  })
  if (rows.length === 0) return null
  return <>{rows}</>
}

export function ChatTranscript({
  worktreePath,
  vendor,
}: {
  worktreePath: string | null
  vendor: string
  title?: string
}) {
  const { daemonConnected, streamConnected } = useAppState()
  const offline = isWebTransportOffline({ daemonConnected, streamConnected })
  const [sessions, setSessions] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [followLatest, setFollowLatest] = useState(true)
  const [messages, setMessages] = useState<HistoryMessage[]>([])
  const [search, setSearch] = useState("")
  const [hideTools, setHideTools] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const mtimeRef = useRef(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const seqRef = useRef(0)
  const followLatestRef = useRef(true)
  const selectedRef = useRef<string | null>(null)
  useEffect(() => {
    followLatestRef.current = followLatest
    selectedRef.current = selected
  }, [followLatest, selected])

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      if (!worktreePath) return
      let seq = seqRef.current
      try {
        const result = await fetchSessions(worktreePath, vendor)
        const changed = result.latestMtime !== mtimeRef.current
        if (!changed && !force) return
        mtimeRef.current = result.latestMtime
        const latest = result.sessions.at(-1) ?? null
        const target = followLatestRef.current
          ? latest
          : (selectedRef.current ?? latest)
        seq = ++seqRef.current
        const next = target ? await fetchMessages(vendor, target) : []
        if (seq !== seqRef.current) return
        setSessions(result.sessions)
        setMessages(next)
        setSelected(target)
        setError(null)
      } catch (err) {
        if (seq === seqRef.current)
          setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === seqRef.current) setLoaded(true)
      }
    },
    [worktreePath, vendor],
  )

  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  // biome-ignore lint/correctness/useExhaustiveDependencies: worktreePath/vendor are the deliberate re-arm triggers (reset on task/vendor switch); the body reaches the live closure via refreshRef, so they aren't read directly.
  useEffect(() => {
    mtimeRef.current = -1
    setLoaded(false)
    followLatestRef.current = true
    selectedRef.current = null
    stickToBottomRef.current = true
    setFollowLatest(true)
    setSelected(null)
    setSearch("")
    setHideTools(false)
    setAtBottom(true)
    void refreshRef.current(true)
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshRef.current()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [worktreePath, vendor])

  const pickSession = (sessionId: string): void => {
    const isLatest = sessionId === sessions.at(-1)
    followLatestRef.current = isLatest
    selectedRef.current = sessionId
    setFollowLatest(isLatest)
    setSelected(sessionId)
    const seq = ++seqRef.current
    void fetchMessages(vendor, sessionId)
      .then((msgs) => {
        if (seq === seqRef.current) setMessages(msgs)
      })
      .catch((err) => {
        if (seq === seqRef.current)
          setError(err instanceof Error ? err.message : String(err))
      })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is the scroll trigger, not a read dependency.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const near = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
    stickToBottomRef.current = near
    setAtBottom(near)
  }

  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickToBottomRef.current = true
    setAtBottom(true)
  }

  const results = useMemo(() => {
    const map = new Map<string, ToolResult>()
    for (const message of messages) {
      for (const block of message.blocks) {
        if (block.type === "tool_result") map.set(block.callId, block)
      }
    }
    return map
  }, [messages])

  const usage = useMemo(() => summarizeUsage(messages), [messages])
  const searchIndex = useMemo(
    () => messages.map((m) => messageSearchText(m).toLowerCase()),
    [messages],
  )
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return messages.filter(
      (m, i) =>
        (!q || searchIndex[i].includes(q)) &&
        messageRendersAnything(m, hideTools),
    )
  }, [messages, searchIndex, search, hideTools])

  if (!worktreePath) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-subtle">
        This task has no worktree yet.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col border border-line bg-bg">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
          Chat
        </span>
        {sessions.length > 0 && (
          <select
            value={selected ?? ""}
            onChange={(event) => pickSession(event.target.value)}
            className="max-w-44 border border-line bg-bg px-1 py-0.5 font-mono text-[10px] text-muted focus:outline-none"
            title="Engine session"
          >
            {sessions.map((id, index) => (
              <option key={id} value={id}>
                #{index + 1} {id.slice(0, 8)}
                {index === sessions.length - 1 ? " (latest)" : ""}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-3 font-mono text-[10px] text-subtle">
          {usage.contextTokens > 0 && (
            <span title="Live context estimate (last turn's full prompt)">
              ctx {formatTokens(usage.contextTokens)}
            </span>
          )}
          {usage.outputTokens > 0 && (
            <span title="Session tokens in / out">
              ⇡{formatTokens(usage.inputTokens)} ⇣
              {formatTokens(usage.outputTokens)}
            </span>
          )}
          <button
            type="button"
            onClick={() => void refresh(true)}
            className="text-subtle transition-colors hover:text-fg"
            title="Refresh transcript"
            aria-label="Refresh transcript"
          >
            <RotateCw size={11} strokeWidth={2} />
          </button>
        </div>
      </div>
      {messages.length > 0 && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2">
          <Search size={11} strokeWidth={2} className="shrink-0 text-subtle" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.preventDefault()
                setSearch("")
              }
            }}
            placeholder="Search transcript…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-fg placeholder:text-subtle focus:outline-none"
          />
          {search.trim() && (
            <span className="shrink-0 font-mono text-[10px] text-subtle">
              {shown.length}/{messages.length}
            </span>
          )}
          {search.trim() && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="shrink-0 text-subtle transition-colors hover:text-fg"
              aria-label="clear transcript search"
              title="Clear search"
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setHideTools((v) => !v)}
            className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
              hideTools
                ? "border-primary bg-inset text-fg"
                : "border-line bg-bg text-subtle hover:border-primary hover:text-fg"
            }`}
            title={
              hideTools
                ? "Show tool calls"
                : "Hide tool calls — read just the conversation"
            }
          >
            {hideTools ? "tools off" : "tools"}
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        >
          {error ? (
            offline ? (
              <div className="py-4 text-[12px] leading-relaxed text-subtle">
                The kobe daemon is offline — the transcript will reappear once
                it reconnects.
              </div>
            ) : (
              <div className="flex flex-col items-start gap-2 py-4">
                <span className="text-[12px] text-kobe-red">
                  Couldn't load the transcript.
                </span>
                <button
                  type="button"
                  onClick={() => void refresh(true)}
                  className="flex items-center gap-1.5 border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
                >
                  <RotateCw size={11} strokeWidth={2} />
                  Retry
                </button>
              </div>
            )
          ) : !loaded ? (
            <div className="py-4 text-[12px] text-subtle">
              Loading transcript…
            </div>
          ) : messages.length === 0 ? (
            <div className="py-4 text-[12px] leading-relaxed text-subtle">
              No engine session recorded for this worktree yet. Open a Vendor
              tab and start a conversation — the transcript appears here.
            </div>
          ) : shown.length === 0 ? (
            <div className="py-4 text-[12px] leading-relaxed text-subtle">
              No messages match “{search.trim()}”.
            </div>
          ) : (
            shown.map((message, index) => (
              <MessageRow
                // biome-ignore lint/suspicious/noArrayIndexKey: transcript is positional + re-rendered wholesale per session; messages carry no stable id, so sessionId+index is the stable-enough key.
                key={`${message.sessionId}-${index}`}
                message={message}
                results={results}
                hideTools={hideTools}
              />
            ))
          )}
        </div>
        {!atBottom && shown.length > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 right-4 flex items-center gap-1 border border-line bg-surface px-2 py-1 font-mono text-[10px] text-muted shadow-md transition-colors hover:border-primary hover:text-fg"
          >
            ↓ latest
          </button>
        )}
      </div>
    </div>
  )
}
