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

import { RotateCw, Search, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  fetchMessages,
  fetchSessions,
  formatTokens,
  type HistoryMessage,
  summarizeUsage,
} from "../lib/history.ts"
import { isNearBottom } from "../lib/scroll.ts"
import { useAppState } from "../lib/store.ts"
import {
  messageRendersAnything,
  messageSearchText,
} from "../lib/transcript-search.ts"
import { isWebTransportOffline } from "../lib/web-transport.ts"
import { MessageRow, type ToolResult } from "./TranscriptRows.tsx"

const POLL_MS = 2_500
export function ChatTranscript({
  worktreePath,
  vendor,
}: {
  worktreePath: string | null
  vendor: string
  /** Accepted for caller compatibility; not rendered in this pane. */
  title?: string
}) {
  // The transcript is served by daemon web transport; if it is down a fetch can
  // only fail, so the error view points at the outage instead of offering a
  // Retry that can't succeed.
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
  // Out-of-order guard (mirrors ChangesList): a fast session pick / poll
  // overlap means a late response for a no-longer-selected session could
  // clobber the displayed messages. Only the most recent request may write.
  const seqRef = useRef(0)
  // Live mirrors of followLatest/selected so an in-flight refresh (whose
  // closure captured the OLD values) recomputes its target against the CURRENT
  // selection after its await — otherwise a poll that overlaps a session pick
  // would write `latest` and snap the user off the session they just picked.
  const followLatestRef = useRef(true)
  const selectedRef = useRef<string | null>(null)
  useEffect(() => {
    followLatestRef.current = followLatest
    selectedRef.current = selected
  }, [followLatest, selected])

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      if (!worktreePath) return
      // Bump the guard only once this refresh commits to a write (after the
      // mtime gate), so a no-op poll tick never invalidates an in-flight pick.
      let seq = seqRef.current
      try {
        const result = await fetchSessions(worktreePath, vendor)
        const changed = result.latestMtime !== mtimeRef.current
        if (!changed && !force) return
        mtimeRef.current = result.latestMtime
        const latest = result.sessions.at(-1) ?? null
        // Read the LIVE selection (refs), not the captured closure, so a pick
        // that landed during the await is honoured instead of snapped to latest.
        const target = followLatestRef.current
          ? latest
          : (selectedRef.current ?? latest)
        seq = ++seqRef.current
        const next = target ? await fetchMessages(vendor, target) : []
        // A newer pick/poll superseded this fetch — drop its result.
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
    followLatestRef.current = true
    selectedRef.current = null
    // Reset scroll-follow too: a task switch remounts (different tab.id) and
    // gets this for free, but an in-place VENDOR switch keeps the same tab.id,
    // so without this the fresh transcript opens stuck scrolled-up.
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
    // Update the live mirrors synchronously so a concurrent in-flight refresh
    // targets this pick immediately (don't wait for the sync effect).
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
  // Precompute each message's lowercased search text once per messages change,
  // so a keystroke filters with a cheap substring check instead of re-running
  // JSON.stringify over every tool result on every key (perceptible lag on a
  // 359-message transcript).
  const searchIndex = useMemo(
    () => messages.map((m) => messageSearchText(m).toLowerCase()),
    [messages],
  )
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    // Keep only messages that BOTH match the query AND would actually render a
    // row (messageRendersAnything mirrors MessageRow — drops tool_result-only
    // and empty text/thinking turns) so the shown/total count, the rendered
    // rows, and the "no matches" empty state all agree.
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
