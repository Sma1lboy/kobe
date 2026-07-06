/** @jsxImportSource @opentui/react */
/**
 * React sidebar mock host (`bun run dev:mock-react-sidebar`) — renders the
 * ported Sidebar against the shared synthetic task fixtures, standing in
 * for the not-yet-ported tasks-pane host (its kv/notifications providers
 * land with a later G3 slice). j/k/enter/g/G//, `[` `]`, and the ticks all
 * run for real; q / ctrl+c quits.
 */

import { useTerminalDimensions } from "@opentui/react"
import { useState } from "react"
import { seedSidebarTasks } from "../../../tui/panes/sidebar/mock-fixtures"
import { bootPaneHost } from "../../lib/host-boot"
import { useBindings } from "../../lib/keymap"
import { Sidebar } from "./Sidebar"

function MockSidebarScreen() {
  const [tasks] = useState(seedSidebarTasks)
  const [selectedId, setSelectedId] = useState<string | null>(tasks[0]?.id ?? null)
  const dims = useTerminalDimensions()

  useBindings(() => ({
    bindings: [
      { key: "q", cmd: () => process.exit(0) },
      { key: "ctrl+c", cmd: () => process.exit(0) },
    ],
  }))

  return (
    <Sidebar
      tasks={tasks}
      selectedId={selectedId}
      onSelect={setSelectedId}
      width={dims.width}
      sortMode="default"
      headerStatus={{ label: "v0.0.0-mock", emphasize: false }}
    />
  )
}

await bootPaneHost({
  logContext: "mock-sidebar",
  setup: () => ({ root: () => <MockSidebarScreen /> }),
})
