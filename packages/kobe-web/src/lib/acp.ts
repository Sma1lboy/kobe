/**
 * ACP session/update folding — the EXPERIMENTAL `claude-acp` vendor's
 * structured sibling of the screen grammar. Raw updates stream from the
 * sidecar (acp-server.mjs) verbatim; this reducer folds them into render
 * items. Pure and total: unknown update kinds are ignored, so a newer
 * adapter never breaks the view.
 */

export type AcpItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thought"; text: string }
  | {
      kind: "tool"
      id: string
      title: string
      status: string
      toolKind?: string
    }
  | { kind: "plan"; entries: { content: string; status: string }[] }

interface ContentChunk {
  type?: string
  text?: string
}

/** One `session/update` payload (ACP spec `sessionUpdate` discriminator). */
export interface AcpUpdate {
  sessionUpdate?: string
  content?: ContentChunk
  toolCallId?: string
  title?: string
  status?: string
  kind?: string
  entries?: { content: string; status: string }[]
  [k: string]: unknown
}

function chunkText(update: AcpUpdate): string {
  return typeof update.content?.text === "string" ? update.content.text : ""
}

/** Append streamed text to a trailing item of `kind`, or open a new one. */
function appendChunk(
  items: readonly AcpItem[],
  kind: "user" | "assistant" | "thought",
  text: string,
): AcpItem[] {
  const last = items.at(-1)
  if (last && last.kind === kind) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...items, { kind, text }]
}

export function applyAcpUpdate(
  items: readonly AcpItem[],
  update: AcpUpdate,
): AcpItem[] {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return appendChunk(items, "user", chunkText(update))
    case "agent_message_chunk":
      return appendChunk(items, "assistant", chunkText(update))
    case "agent_thought_chunk":
      return appendChunk(items, "thought", chunkText(update))
    case "tool_call":
      return [
        ...items,
        {
          kind: "tool",
          id: String(update.toolCallId ?? ""),
          title: String(update.title ?? "tool"),
          status: String(update.status ?? "pending"),
          ...(update.kind ? { toolKind: String(update.kind) } : {}),
        },
      ]
    case "tool_call_update":
      return items.map((item) =>
        item.kind === "tool" && item.id === String(update.toolCallId ?? "")
          ? {
              ...item,
              ...(update.status ? { status: String(update.status) } : {}),
              ...(update.title ? { title: String(update.title) } : {}),
            }
          : item,
      )
    case "plan": {
      const entries = Array.isArray(update.entries)
        ? update.entries.map((e) => ({
            content: String(e.content ?? ""),
            status: String(e.status ?? ""),
          }))
        : []
      // One live plan: replace the previous plan item if present.
      const without = items.filter((item) => item.kind !== "plan")
      return [...without, { kind: "plan", entries }]
    }
    default:
      return [...items]
  }
}
