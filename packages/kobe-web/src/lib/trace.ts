import { api } from "./api-client.ts"

export type TraceStatus = "running" | "success" | "error" | "blocked"
export type TraceNodeKind =
  | "commentary"
  | "reasoning"
  | "tool"
  | "change"
  | "answer"
  | "subagent"
  | "compaction"
export type TraceParentBasis = "explicit" | "temporal" | "none"

export interface TraceNode {
  id: string
  turnId: string
  parentId: string | null
  parentBasis: TraceParentBasis
  kind: TraceNodeKind
  status: TraceStatus
  title: string
  summary: string
  detail: string
  resultDetail: string | null
  retryOf?: string | null
  attempt?: number
  startedAt: number
  endedAt: number | null
}

export interface TraceTurn {
  id: string
  title: string
  startedAt: number
  endedAt: number | null
  status: TraceStatus
  nodes: TraceNode[]
}

export interface EngineTrace {
  sessionId: string
  turns: TraceTurn[]
}

export interface LiveTraceEvent {
  kind: string
  sessionId?: string
  at: number
  detail?: {
    turnId?: string
    tool?: {
      name?: string
      id?: string
      input?: string
      output?: string
      isError?: boolean
    }
    compact?: { trigger?: "manual" | "auto" }
    subagent?: {
      type?: string
      id?: string
      transcriptPath?: string
      result?: string
    }
  }
}

export async function fetchTrace(
  vendor: string,
  sessionId: string,
): Promise<EngineTrace> {
  const { trace } = await api.get<{ trace: EngineTrace }>(
    "/api/history/trace",
    {
      query: { vendor, sessionId },
      label: "/api/history/trace",
    },
  )
  return trace
}

/** Subscribe to recoverable full snapshots. EventSource reconnects
 * automatically; every connection receives an initial snapshot, so the
 * browser never has to replay or reconcile missed deltas. */
export function subscribeTrace(
  vendor: string,
  sessionId: string,
  onTrace: (trace: EngineTrace) => void,
  onError?: (message: string) => void,
): () => void {
  const query = new URLSearchParams({ vendor, sessionId })
  const source = new EventSource(`/api/history/trace/events?${query}`)
  source.addEventListener("trace", (event) => {
    try {
      const trace = JSON.parse(event.data) as EngineTrace
      if (trace && trace.sessionId === sessionId && Array.isArray(trace.turns))
        onTrace(trace)
    } catch {
      onError?.("Invalid Agent Trace snapshot")
    }
  })
  source.addEventListener("trace-error", (event) => {
    try {
      const payload = JSON.parse(event.data) as { error?: unknown }
      onError?.(
        typeof payload.error === "string"
          ? payload.error
          : "Agent Trace stream failed",
      )
    } catch {
      onError?.("Agent Trace stream failed")
    }
  })
  return () => source.close()
}

export function subscribeLiveTrace(
  taskId: string,
  sessionId: string,
  onEvent: (event: LiveTraceEvent) => void,
): () => void {
  const query = new URLSearchParams({ taskId, sessionId })
  const source = new EventSource(`/api/history/trace/live?${query}`)
  source.addEventListener("trace-event", (event) => {
    try {
      const value = JSON.parse(event.data) as LiveTraceEvent
      if (value?.sessionId === sessionId && typeof value.at === "number")
        onEvent(value)
    } catch {
      // A malformed ephemeral event is dropped; the persisted snapshot heals it.
    }
  })
  return () => source.close()
}

function liveTurnId(trace: EngineTrace, event: LiveTraceEvent): string {
  if (event.detail?.turnId) return event.detail.turnId
  for (let index = trace.turns.length - 1; index >= 0; index -= 1) {
    const turn = trace.turns[index]
    if (turn?.status === "running") return turn.id
  }
  return `turn:live:${trace.sessionId}`
}

function updateTurn(
  trace: EngineTrace,
  id: string,
  event: LiveTraceEvent,
  update: (turn: TraceTurn) => TraceTurn,
): EngineTrace {
  const index = trace.turns.findIndex((turn) => turn.id === id)
  const turns = trace.turns.slice()
  if (index >= 0) {
    const current = turns[index]
    if (!current) return trace
    turns[index] = update(current)
  } else {
    turns.push(
      update({
        id,
        title: "Current turn",
        startedAt: event.at,
        endedAt: null,
        status: "running",
        nodes: [],
      }),
    )
  }
  return { ...trace, turns }
}

function mergeLiveNode(
  trace: EngineTrace,
  turnId: string,
  event: LiveTraceEvent,
  node: TraceNode,
): EngineTrace {
  return updateTurn(trace, turnId, event, (turn) => {
    const index = turn.nodes.findIndex((candidate) => candidate.id === node.id)
    if (index < 0)
      return {
        ...turn,
        status: node.status === "error" ? "error" : "running",
        endedAt: null,
        nodes: [...turn.nodes, node],
      }
    const current = turn.nodes[index]
    if (!current) return turn
    if (
      event.kind === "tool-pre" &&
      current.status !== "running" &&
      (current.endedAt ?? 0) >= event.at
    )
      return turn
    const nodes = turn.nodes.slice()
    nodes[index] = {
      ...current,
      ...node,
      parentId: current.parentId,
      parentBasis: current.parentBasis,
      detail: node.detail || current.detail,
      resultDetail: node.resultDetail ?? current.resultDetail,
      startedAt: Math.min(current.startedAt, node.startedAt),
    }
    return {
      ...turn,
      status: node.status === "error" ? "error" : "running",
      endedAt: null,
      nodes,
    }
  })
}

/** Fold one ephemeral hook event over a persisted snapshot. Node IDs make
 * replay idempotent; a later full snapshot replaces the overlay wholesale. */
export function applyLiveTraceEvent(
  trace: EngineTrace,
  event: LiveTraceEvent,
): EngineTrace {
  if (event.sessionId !== trace.sessionId) return trace
  const turnId = liveTurnId(trace, event)

  if (event.kind === "turn-start") {
    return updateTurn(trace, turnId, event, (turn) => {
      if ((turn.endedAt ?? Number.POSITIVE_INFINITY) < event.at) return turn
      return { ...turn, status: "running", endedAt: null }
    })
  }
  if (
    event.kind === "turn-complete" ||
    event.kind === "turn-failed" ||
    event.kind === "turn-interrupted"
  ) {
    const status: TraceStatus =
      event.kind === "turn-failed" ? "error" : "success"
    return updateTurn(trace, turnId, event, (turn) => ({
      ...turn,
      status,
      endedAt: Math.max(turn.endedAt ?? turn.startedAt, event.at),
    }))
  }

  const tool = event.detail?.tool
  if ((event.kind === "tool-pre" || event.kind === "tool-post") && tool?.id) {
    return mergeLiveNode(trace, turnId, event, {
      id: tool.id,
      turnId,
      parentId: null,
      parentBasis: "none",
      kind: /apply.?patch|edit|write|notebook|file.?pen/i.test(tool.name ?? "")
        ? "change"
        : "tool",
      status:
        event.kind === "tool-pre"
          ? "running"
          : tool.isError
            ? "error"
            : "success",
      title: tool.name || "Tool",
      summary: (tool.input ?? "").replace(/\s+/g, " ").slice(0, 72),
      detail: tool.input ?? "",
      resultDetail: tool.output ?? null,
      startedAt: event.at,
      endedAt: event.kind === "tool-post" ? event.at : null,
    })
  }

  if (event.kind === "subagent-start" || event.kind === "subagent-stop") {
    const subagent = event.detail?.subagent
    const id = subagent?.id || `subagent:${turnId}:${event.at}`
    return mergeLiveNode(trace, turnId, event, {
      id,
      turnId,
      parentId: null,
      parentBasis: "none",
      kind: "subagent",
      status: event.kind === "subagent-start" ? "running" : "success",
      title: subagent?.type || "Subagent",
      summary: subagent?.id ?? "",
      detail: [subagent?.id, subagent?.transcriptPath]
        .filter(Boolean)
        .join("\n"),
      resultDetail: subagent?.result ?? null,
      startedAt: event.at,
      endedAt: event.kind === "subagent-stop" ? event.at : null,
    })
  }

  if (event.kind === "pre-compact" || event.kind === "post-compact") {
    return mergeLiveNode(trace, turnId, event, {
      id: `compact:${turnId}`,
      turnId,
      parentId: null,
      parentBasis: "none",
      kind: "compaction",
      status: event.kind === "pre-compact" ? "running" : "success",
      title: "Context compaction",
      summary: event.detail?.compact?.trigger ?? "",
      detail: "",
      resultDetail: null,
      startedAt: event.at,
      endedAt: event.kind === "post-compact" ? event.at : null,
    })
  }
  return trace
}
