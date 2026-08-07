/**
 * Presentation-only helpers for the engine-owned Agent Trace contract.
 *
 * Vendor parsing, identity assignment, status normalization, and causal
 * inference happen behind the engine registry. The browser may overlay coarse
 * daemon liveness while a trace append is still becoming visible, but it does
 * not reconstruct trace nodes from transcript messages.
 */

import type { EngineTrace, TraceNode, TraceStatus, TraceTurn } from "./trace.ts"

export type TimelineStatus = TraceStatus
export type TimelineItem = TraceNode
export type TimelineTurn = TraceTurn
export type TimelineModel = EngineTrace

/** Merge coarse daemon liveness into the latest engine-owned trace turn. When
 * the prompt has not landed in the engine trace yet, synthesize one live root
 * so the pane reacts immediately instead of waiting for transcript persistence.
 * Synthetic roots carry no causal nodes and are replaced on the next trace
 * refresh. */
export function withLiveState(
  model: TimelineModel,
  state: string | undefined,
  at: number,
): TimelineModel {
  const status: TimelineStatus | null =
    state === "running"
      ? "running"
      : state === "permission_needed"
        ? "blocked"
        : state === "error" || state === "rate_limited"
          ? "error"
          : null
  if (!status) return model

  if (model.turns.length === 0) {
    return {
      ...model,
      turns: [
        {
          id: `turn:live:${model.sessionId || "pending"}`,
          title: status === "blocked" ? "Waiting for input" : "Current turn",
          startedAt: at,
          endedAt: null,
          status,
          nodes: [],
        },
      ],
    }
  }

  const turns = model.turns.slice()
  const last = turns.at(-1)
  if (!last) return model
  if (last.status !== "running" && last.endedAt !== null && at > last.endedAt) {
    turns.push({
      id: `turn:live:${model.sessionId || "pending"}:${at}`,
      title: status === "blocked" ? "Waiting for input" : "Current turn",
      startedAt: at,
      endedAt: null,
      status,
      nodes: [],
    })
    return { ...model, turns }
  }
  turns[turns.length - 1] = { ...last, status, endedAt: null }
  return { ...model, turns }
}

export function durationMs(
  startedAt: number,
  endedAt: number | null,
  now: number,
): number {
  return Math.max(0, (endedAt ?? now) - startedAt)
}
