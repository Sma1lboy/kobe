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
