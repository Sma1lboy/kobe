/**
 * Vendor-neutral execution trace produced by engine adapters.
 *
 * This is an observability model, not a second conversation store. Stable
 * engine ids survive into the UI; inferred ordering is labelled `temporal`
 * so a renderer never presents adjacency as hidden chain-of-thought.
 */

export type EngineTraceStatus = "running" | "success" | "error" | "blocked"

export type EngineTraceNodeKind = "commentary" | "reasoning" | "tool" | "change" | "answer" | "subagent" | "compaction"

export type EngineTraceParentBasis = "explicit" | "temporal" | "none"

export interface EngineTraceNode {
  /** Stable engine item/call id when available; adapter-stable fallback otherwise. */
  readonly id: string
  readonly turnId: string
  readonly parentId: string | null
  /** Why `parentId` exists. Temporal edges must not render as proven causality. */
  readonly parentBasis: EngineTraceParentBasis
  readonly kind: EngineTraceNodeKind
  readonly status: EngineTraceStatus
  readonly title: string
  readonly summary: string
  /** Complete bounded public narration or normalized tool input. */
  readonly detail: string
  /** Complete bounded tool output; null for non-tools or pending tools. */
  readonly resultDetail: string | null
  /** Engine-declared retry provenance. The UI never infers retries from adjacency. */
  readonly retryOf?: string | null
  /** One-based engine-declared attempt number. Omitted when the source has no such fact. */
  readonly attempt?: number
  readonly startedAt: number
  readonly endedAt: number | null
}

export interface EngineTraceTurn {
  readonly id: string
  readonly title: string
  readonly startedAt: number
  readonly endedAt: number | null
  readonly status: EngineTraceStatus
  readonly nodes: readonly EngineTraceNode[]
}

export interface EngineTrace {
  readonly sessionId: string
  readonly turns: readonly EngineTraceTurn[]
}

export function emptyEngineTrace(sessionId: string): EngineTrace {
  return { sessionId, turns: [] }
}
