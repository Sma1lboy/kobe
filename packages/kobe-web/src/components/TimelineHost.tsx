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
  onCollapse,
}: {
  taskId: string
  worktreePath: string | null
  vendor: string
  engineState: EngineState | undefined
  /** Active tab's hook-reported session — see useTimelineData. */
  tabSessionId?: string
  onCollapse: () => void
}) {
  const engines = useEngines()
  const label = engineLabel(engines, vendor)
  const data = useTimelineData({
    taskId,
    worktreePath,
    vendor,
    engineState,
    tabSessionId,
  })
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <TimelinePanel
        {...data}
        engineLabel={label}
        onExpand={() => setExpanded(true)}
        onCollapse={onCollapse}
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
