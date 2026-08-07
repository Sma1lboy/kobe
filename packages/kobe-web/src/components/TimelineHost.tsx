import { useState } from "react"
import { useEngines } from "../lib/engines.ts"
import type { PendingTraceQuote } from "../lib/trace-content.ts"
import type {
  EngineSessionBinding,
  EngineSessionTransition,
  EngineState,
} from "../lib/types.ts"
import { useTimelineData } from "../lib/use-timeline-data.ts"
import { engineLabel } from "../lib/vendor.ts"
import { TimelinePanel } from "./TimelinePanel.tsx"
import { TimelineSwimlane } from "./TimelineSwimlane.tsx"

export function TimelineHost({
  taskId,
  vendor,
  engineState,
  binding,
  transition,
  legacySessionId,
  engineActive = true,
  width,
  onQuote,
}: {
  taskId: string
  vendor: string
  engineState: EngineState | undefined
  /** Durable daemon-owned current EngineRun for this tab. */
  binding?: EngineSessionBinding
  /** Non-durable phase between native resume detection and selected identity. */
  transition?: EngineSessionTransition
  /** Exact-id fallback for an older daemon without the binding contract. */
  legacySessionId?: string
  /** Engine liveness of the active tab; off keeps bound history visible. */
  engineActive?: boolean
  /** Drag-resized panel width (PaneResizer). */
  width?: number
  /** Insert one block reference into the active native composer. */
  onQuote?: (quote: PendingTraceQuote) => Promise<void>
}) {
  const engines = useEngines()
  const label = engineLabel(engines, vendor)
  const data = useTimelineData({
    taskId,
    vendor,
    // Liveness may decorate the bound session but never chooses its identity.
    engineState: engineActive ? engineState : undefined,
    binding,
    transition,
    legacySessionId,
  })
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <TimelinePanel
        {...data}
        engineLabel={label}
        active={engineActive}
        bindingState={data.bindingState}
        runId={binding?.runId}
        width={width}
        onQuote={onQuote}
        onExpand={() => setExpanded(true)}
      />
      {expanded && (
        <TimelineSwimlane
          model={data.model}
          engineLabel={label}
          runId={binding?.runId}
          onQuote={onQuote}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  )
}
