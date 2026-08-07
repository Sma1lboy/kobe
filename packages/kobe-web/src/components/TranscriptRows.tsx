/**
 * Row renderers for the structured transcript — tool calls paired with their
 * results (collapsed by default), thinking blocks, and message rows. Split
 * from ChatTranscript.tsx, which keeps the session load/poll/search frame.
 * tool_result blocks are NEVER rendered standalone — they attach to their
 * tool_call row (pairing by callId is the contract; Codex emits results on
 * role:"user" records, so grouping by role would mis-render).
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import { useState } from "react"
import type { ContentBlock, HistoryMessage } from "../lib/history.ts"
import { relativeTime } from "../lib/time.ts"
import { outputText, toolInputSummary } from "../lib/tool-display.ts"
import { blockVisible } from "../lib/transcript-search.ts"

export type ToolResult = Extract<ContentBlock, { type: "tool_result" }>
export type ToolCall = Extract<ContentBlock, { type: "tool_call" }>

const OUTPUT_PREVIEW_CHARS = 600

/** One-line, human-scannable summary of a tool's input (per-tool narrowing). */
export function ToolRow({
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

export function ThinkingRow({ text }: { text: string }) {
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

export function MessageRow({
  message,
  results,
  hideTools,
}: {
  message: HistoryMessage
  results: ReadonlyMap<string, ToolResult>
  hideTools: boolean
}) {
  const rows: React.ReactNode[] = []
  // Relative time of this turn ("3m", "2h", "2d"), anchored once on the user
  // prompt so a long session reads with periodic time markers. Empty/unparseable
  // timestamps render nothing.
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
    // tool_result: rendered inline under its tool_call row — never standalone.
  })
  if (rows.length === 0) return null
  return <>{rows}</>
}
