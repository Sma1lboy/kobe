/** @jsxImportSource @opentui/react */

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
