/**
 * Row renderers for the structured transcript — the "translate the session
 * into precise HTML" layer (the kaku move): user prompts as compact chips,
 * assistant text through the safe markdown renderer, tool calls as iconed
 * cards with collapsed output, thinking collapsed to one italic line.
 *
 * tool_result blocks are NEVER rendered standalone — they attach to their
 * tool_call row (pairing by callId is the contract; Codex emits results on
 * role:"user" records, so grouping by role would mis-render).
 */

import {
  Bot,
  ChevronDown,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react"
import { useState } from "react"
import type { ContentBlock, HistoryMessage } from "../lib/history.ts"
import { renderMarkdown } from "../lib/markdown.ts"
import { relativeTime } from "../lib/time.ts"
import { outputText, toolInputSummary } from "../lib/tool-display.ts"
import { blockVisible } from "../lib/transcript-search.ts"
import "./notes-markdown.css"

export type ToolResult = Extract<ContentBlock, { type: "tool_result" }>
export type ToolCall = Extract<ContentBlock, { type: "tool_call" }>

const ERROR_PREVIEW_CHARS = 240

/** Icon per tool family — names are engine-owned strings, so match loosely
 *  on the common verbs and fall back to a wrench. */
function toolIcon(name: string): React.ComponentType<{
  size?: number
  strokeWidth?: number
  className?: string
}> {
  const n = name.toLowerCase()
  if (n.includes("bash") || n.includes("shell") || n.includes("terminal"))
    return SquareTerminal
  if (n.includes("read")) return FileText
  if (n.includes("write") || n.includes("edit") || n.includes("notebook"))
    return FilePen
  if (n.includes("grep") || n.includes("glob") || n.includes("search"))
    return Search
  if (n.includes("web") || n.includes("fetch")) return Globe
  if (n.includes("task") || n.includes("todo")) return ListTodo
  if (n.includes("agent")) return Bot
  return Wrench
}

/** One tool call as a card: icon + name + input summary in the header,
 *  output collapsed behind a click (errors preview inline). */
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
  const isError = result?.isError === true
  const expandable = body.length > 0
  const Icon = toolIcon(call.name)
  return (
    <div
      className={`my-1.5 overflow-hidden rounded-md border ${
        isError ? "border-kobe-red/40" : "border-line"
      } bg-surface/60`}
    >
      <button
        type="button"
        onClick={() => expandable && setOpen((cur) => !cur)}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left ${
          expandable ? "cursor-pointer hover:bg-inset/40" : "cursor-default"
        }`}
      >
        <Icon
          size={13}
          strokeWidth={2}
          className={`shrink-0 ${
            isError
              ? "text-kobe-red"
              : result
                ? "text-kobe-green"
                : "text-subtle"
          }`}
        />
        <span className="shrink-0 text-[12px] font-semibold text-fg">
          {call.name}
        </span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle">
            {summary}
          </span>
        )}
        {!result && (
          <span className="shrink-0 text-[10px] italic text-subtle">
            running…
          </span>
        )}
        {expandable && (
          <span className="shrink-0 text-subtle">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>
      {isError && !open && body && (
        <div className="border-t border-kobe-red/20 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-kobe-red/90">
          {body.length > ERROR_PREVIEW_CHARS
            ? `${body.slice(0, ERROR_PREVIEW_CHARS)}…`
            : body}
        </div>
      )}
      {open && body && (
        <pre
          className={`max-h-96 overflow-auto whitespace-pre-wrap break-words border-t px-2.5 py-2 font-mono text-[11px] leading-relaxed ${
            isError
              ? "border-kobe-red/20 text-kobe-red/90"
              : "border-line text-muted"
          }`}
        >
          {body}
        </pre>
      )}
    </div>
  )
}

export function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen((cur) => !cur)}
        className="flex items-baseline gap-2 text-[11px] italic text-subtle hover:text-muted"
      >
        <span className="text-primary/70">✱</span>
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

/** User prompt as a compact chip (kaku's grammar), with the turn's relative
 *  time at the right edge. */
function UserBubble({
  text,
  stamp,
  iso,
}: {
  text: string
  stamp: string
  iso: string
}) {
  return (
    <div className="my-3 flex items-start gap-2">
      <div className="max-w-[85%] rounded-lg border border-line bg-inset px-3 py-1.5">
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
          {text}
        </p>
      </div>
      {stamp && (
        <span
          className="mt-1 shrink-0 font-mono text-[10px] text-subtle"
          title={iso}
        >
          {stamp}
        </span>
      )}
    </div>
  )
}

/** Assistant text: ⏺ dot column + markdown body (escaped-first renderer). */
function AssistantText({ text, system }: { text: string; system: boolean }) {
  return (
    <div className="my-2 flex gap-2.5">
      <span
        className={`mt-[3px] shrink-0 text-[11px] ${system ? "text-subtle" : "text-primary"}`}
      >
        ⏺
      </span>
      <div
        className={`kobe-md min-w-0 flex-1 text-[13px] leading-relaxed ${
          system ? "text-subtle" : "text-fg/90"
        }`}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes all input first and emits only its own tags (see lib/markdown.ts); covered by tests.
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
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
          <UserBubble
            key={key}
            text={block.text}
            stamp={stamped ? "" : stamp}
            iso={message.timestamp}
          />,
        )
        stamped = true
      } else {
        rows.push(
          <AssistantText
            key={key}
            text={block.text}
            system={message.role === "system"}
          />,
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
