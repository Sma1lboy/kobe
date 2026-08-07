import { useState } from "react"
import { useEngines } from "../lib/engines.ts"
import type { EngineState } from "../lib/types.ts"
import { useTimelineData } from "../lib/use-timeline-data.ts"
import { engineLabel } from "../lib/vendor.ts"
import { TimelinePanel } from "./TimelinePanel.tsx"
import { TimelineSwimlane } from "./TimelineSwimlane.tsx"

export function TimelineHost({
  taskId,
  worktreePath,
  vendor,
  engineState,
  tabSessionId,
  engineActive = true,
  bound = true,
  width,
}: {
  taskId: string
  worktreePath: string | null
  vendor: string
  engineState: EngineState | undefined
  /** Active tab's hook-reported session — see useTimelineData. */
  tabSessionId?: string
  /** Engine liveness of the active tab (grammar-derived) — off clears the panel. */
  engineActive?: boolean
  /** The tab's screen shows a conversation — without it (fresh boot) the
   *  trace must not bind to the previous session's transcript. */
  bound?: boolean
  /** Drag-resized panel width (PaneResizer). */
  width?: number
}) {
  const engines = useEngines()
  const label = engineLabel(engines, vendor)
  const data = useTimelineData({
    taskId,
    worktreePath,
    vendor,
    engineState,
    tabSessionId,
    bound,
  })
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <TimelinePanel
        {...data}
        engineLabel={label}
        active={engineActive}
        width={width}
        onExpand={() => setExpanded(true)}
      />
      {expanded && (
        <TimelineSwimlane
          model={data.model}
          engineLabel={label}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  )
}
