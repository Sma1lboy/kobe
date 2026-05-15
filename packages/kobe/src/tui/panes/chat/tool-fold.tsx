import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import type { ChatRow } from "./row-types"
import { classifyTool } from "./tool-registry"

type ToolCounts = { search: number; read: number; list: number; bash: number; other: number }

export type MessageRenderItem =
  | { kind: "row"; row: ChatRow; index: number }
  | { kind: "fold"; counts: ToolCounts; startIndex: number; inFlight: number }

const TOOL_FOLD_THRESHOLD = 3

export function groupRenderItems(
  messages: readonly ChatRow[],
  expandedFoldStartIndex: number | null = null,
): MessageRenderItem[] {
  const items: MessageRenderItem[] = []
  let i = 0
  while (i < messages.length) {
    const row = messages[i]
    if (!row || row.kind !== "tool") {
      if (row) items.push({ kind: "row", row, index: i })
      i++
      continue
    }
    let j = i
    while (j < messages.length && messages[j]?.kind === "tool") j++
    if (j - i >= TOOL_FOLD_THRESHOLD) {
      const counts: ToolCounts = { search: 0, read: 0, list: 0, bash: 0, other: 0 }
      let inFlight = 0
      for (let k = i; k < j; k++) {
        const r = messages[k]
        if (r?.kind !== "tool") continue
        counts[classifyTool(r.name)]++
        if (!r.done) inFlight++
      }
      items.push({ kind: "fold", counts, startIndex: i, inFlight })
      if (expandedFoldStartIndex === i) {
        for (let k = i; k < j; k++) {
          const r = messages[k]
          if (r) items.push({ kind: "row", row: r, index: k })
        }
      }
    } else {
      for (let k = i; k < j; k++) {
        const r = messages[k]
        if (r) items.push({ kind: "row", row: r, index: k })
      }
    }
    i = j
  }
  return items
}

/**
 * "Searched for 5 patterns, read 3 files, ran 10 bash commands" —
 * mirrors Claude Code's collapsed tool-run summary. When `inFlight`
 * is true, switch to present continuous.
 */
export function summarizeToolRun(c: ToolCounts, inFlight = false): string {
  const verbs = inFlight
    ? {
        search: ["Searching", "searching"],
        read: ["Reading", "reading"],
        list: ["Listing", "listing"],
        bash: ["Running", "running"],
        other: ["Using", "using"],
      }
    : {
        search: ["Searched", "searched"],
        read: ["Read", "read"],
        list: ["Listed", "listed"],
        bash: ["Ran", "ran"],
        other: ["Used", "used"],
      }
  const parts: string[] = []
  if (c.search > 0) {
    const [vUp, vLo] = verbs.search
    const verb = parts.length === 0 ? vUp : vLo
    const tail = inFlight
      ? `${c.search} ${c.search === 1 ? "pattern" : "patterns"}`
      : `for ${c.search} ${c.search === 1 ? "pattern" : "patterns"}`
    parts.push(`${verb} ${tail}`)
  }
  if (c.read > 0) {
    const [vUp, vLo] = verbs.read
    const verb = parts.length === 0 ? vUp : vLo
    parts.push(`${verb} ${c.read} ${c.read === 1 ? "file" : "files"}`)
  }
  if (c.list > 0) {
    const [vUp, vLo] = verbs.list
    const verb = parts.length === 0 ? vUp : vLo
    parts.push(`${verb} ${c.list} ${c.list === 1 ? "directory" : "directories"}`)
  }
  if (c.bash > 0) {
    const [vUp, vLo] = verbs.bash
    const verb = parts.length === 0 ? vUp : vLo
    parts.push(`${verb} ${c.bash} bash ${c.bash === 1 ? "command" : "commands"}`)
  }
  if (c.other > 0) {
    const [vUp, vLo] = verbs.other
    const verb = parts.length === 0 ? vUp : vLo
    parts.push(`${verb} ${c.other} ${c.other === 1 ? "other tool" : "other tools"}`)
  }
  return parts.join(", ")
}

export function ToolFoldRow(props: { summary: string; expanded: boolean; inFlight: boolean; onToggle: () => void }) {
  const { theme } = useTheme()
  const glyph = () => (props.inFlight ? "✻" : props.expanded ? "▼" : "▶")
  const fg = () => (props.inFlight ? theme.warning : theme.textMuted)
  return (
    <box paddingTop={1} flexDirection="row" gap={1} onMouseUp={() => props.onToggle()}>
      <text fg={fg()} attributes={TextAttributes.DIM}>
        {glyph()}
      </text>
      <box flexGrow={1}>
        <text fg={theme.textMuted}>{props.summary}</text>
      </box>
    </box>
  )
}

// Re-exported for older callers / tests that import classifyTool from
// MessageList. New code should import directly from `./tool-registry`.
export { classifyTool }
