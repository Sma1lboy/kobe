/**
 * ChatTranscript — a structured, read-only view of a task's persisted engine
 * session: real message rows (user / assistant / thinking) and tool calls
 * paired with their results by callId, instead of raw PTY bytes. Data comes
 * from the bridge's /api/history routes (engine-neutral Message[]); a light
 * mtime poll keeps it live while the engine works.
 *
 * Rendering notes (mirroring Claude Code's stream grammar, simplified):
 *  - tool_result blocks are NEVER rendered standalone — they attach to their
 *    tool_call row. Codex emits results on role:"user" records, so grouping
 *    by role would mis-render; pairing by callId is the contract.
 *  - thinking and tool output bodies are collapsed by default.
 */

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
import { outputText, toolInputSummary } from "../lib/tool-display.ts"
import { messageMatchesQuery } from "../lib/transcript-search.ts"

const POLL_MS = 2_500
const OUTPUT_PREVIEW_CHARS = 600

type ToolResult = Extract<ContentBlock, { type: "tool_result" }>
type ToolCall = Extract<ContentBlock, { type: "tool_call" }>

/** One-line, human-scannable summary of a tool's input (per-tool narrowing). */
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
}: {
  message: HistoryMessage
  results: ReadonlyMap<string, ToolResult>
}) {
  const rows: React.ReactNode[] = []
  message.blocks.forEach((block, index) => {
    const key = `${message.timestamp}-${index}`
    if (block.type === "text") {
      if (!block.text.trim()) return
      if (message.role === "user") {
        rows.push(
          <div
            key={key}
            className="my-2 flex gap-2 border-l-2 border-primary/60 bg-inset/40 px-3 py-2"
          >
            <span className="shrink-0 font-mono text-[12px] font-bold text-primary">
              ❯
            </span>
            <p className="min-w-0 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg">
              {block.text}
            </p>
          </div>,
        )
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
    // tool_result: rendered inline under its tool_call row — never standalone.
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
}) {
  const [sessions, setSessions] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [followLatest, setFollowLatest] = useState(true)
  const [messages, setMessages] = useState<HistoryMessage[]>([])
  const [search, setSearch] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const mtimeRef = useRef(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      if (!worktreePath) return
      try {
        const result = await fetchSessions(worktreePath, vendor)
        const changed = result.latestMtime !== mtimeRef.current
        if (!changed && !force) return
        mtimeRef.current = result.latestMtime
        setSessions(result.sessions)
        const latest = result.sessions.at(-1) ?? null
        const target = followLatest ? latest : (selected ?? latest)
        if (target) {
          setMessages(await fetchMessages(vendor, target))
          setSelected(target)
        } else {
          setMessages([])
          setSelected(null)
        }
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoaded(true)
      }
    },
    [worktreePath, vendor, followLatest, selected],
  )

  // The poll must call the CURRENT refresh (which captures followLatest/
  // selected), not the one from when the interval was armed — otherwise
  // picking an older session snaps back to latest every tick. Keep refresh in
  // a ref so the timer reads the live closure without re-arming on every
  // session pick.
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  // Initial load + light poll; mtime gate means idle ticks cost one stat-ish
  // request and zero message fetches. Hidden tabs skip work entirely. Re-armed
  // only on task/vendor switch (not on every session pick).
  // biome-ignore lint/correctness/useExhaustiveDependencies: worktreePath/vendor are the deliberate re-arm triggers (reset on task/vendor switch); the body reaches the live closure via refreshRef, so they aren't read directly.
  useEffect(() => {
    mtimeRef.current = -1
    setLoaded(false)
    setFollowLatest(true)
    setSelected(null)
    setSearch("")
    void refreshRef.current(true)
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshRef.current()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [worktreePath, vendor])

  const pickSession = (sessionId: string): void => {
    const isLatest = sessionId === sessions.at(-1)
    setFollowLatest(isLatest)
    setSelected(sessionId)
    void fetchMessages(vendor, sessionId)
      .then(setMessages)
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
  }

  // Stick to the bottom while the engine streams, unless the user scrolled up.
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
  const shown = useMemo(
    () =>
      search.trim()
        ? messages.filter((m) => messageMatchesQuery(m, search))
        : messages,
    [messages, search],
  )

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
            placeholder="Search transcript…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-fg placeholder:text-subtle focus:outline-none"
          />
          {search.trim() && (
            <>
              <span className="shrink-0 font-mono text-[10px] text-subtle">
                {shown.length}/{messages.length}
              </span>
              <button
                type="button"
                onClick={() => setSearch("")}
                className="shrink-0 text-subtle transition-colors hover:text-fg"
                aria-label="clear transcript search"
                title="Clear search"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </>
          )}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        >
          {error ? (
            <div className="py-4 text-[12px] text-kobe-red">{error}</div>
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
