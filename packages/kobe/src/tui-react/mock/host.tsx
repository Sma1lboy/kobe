/** @jsxImportSource @opentui/react */
/**
 * `dev:mock-react` — THE general mock scene (owner call 2026-07-09: one
 * bench, stuff everything in). Composes the real app shape without a
 * daemon/orchestrator: the real Sidebar against the shared synthetic
 * fixtures (many projects + mixed-status tasks) next to real TerminalTabs
 * running throwaway shells, on the full provider stack (theme → focus →
 * kv → notifications → dialog). New UI surfaces that need a visual bench
 * get ADDED HERE, not a new dev:mock-* entry — per-pane hosts remain only
 * where a pane needs bespoke seams (history's injectable reader, etc.).
 *
 * Keys: q / ctrl+c quit · tab cycles pane focus · sidebar j/k/enter live ·
 * terminal tabs ctrl+t/w/]/[ + ctrl+\ / ctrl+= splits live.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { useState } from "react"
import { seedSidebarTasks } from "../../tui/panes/sidebar/mock-fixtures"
import { SIDEBAR_WIDTH } from "../../tui/panes/sidebar/view-core"
import { useFocus } from "../context/focus"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { Sidebar } from "../panes/sidebar/Sidebar"
import { TerminalTabs } from "../workspace/TerminalTabs"

const cwd = mkdtempSync(join(tmpdir(), "kobe-mock-react-"))

function MockScene() {
  const { theme } = useTheme()
  const focus = useFocus()
  const [tasks] = useState(seedSidebarTasks)
  const [selectedId, setSelectedId] = useState<string | null>(tasks.find((t) => t.kind === "task")?.id ?? null)

  useBindings(() => ({
    bindings: [
      { key: "q", cmd: () => process.exit(0) },
      { key: "ctrl+c", cmd: () => process.exit(0) },
      { key: "tab", cmd: () => focus.cycle(1) },
      { key: "shift+tab", cmd: () => focus.cycle(-1) },
    ],
  }))

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.background}>
      <box
        width={SIDEBAR_WIDTH}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
        borderColor={focus.focused === "sidebar" ? theme.focusAccent : theme.borderSubtle}
        onMouseUp={() => focus.setFocused("sidebar")}
      >
        <Sidebar
          width={SIDEBAR_WIDTH - 2}
          tasks={tasks}
          selectedId={selectedId}
          onSelect={setSelectedId}
          focused={focus.focused === "sidebar"}
          sortMode="default"
          headerStatus={{ label: "v0.0.0-mock", emphasize: false }}
        />
      </box>
      <box
        flexGrow={1}
        borderColor={focus.focused !== "sidebar" ? theme.focusAccent : theme.borderSubtle}
        onMouseUp={() => focus.setFocused("workspace")}
      >
        <TerminalTabs
          taskId="mock-workspace-task"
          worktree={cwd}
          command={["sh", "-c", 'echo MOCK-SCENE-OK "(cwd: $PWD)"; exec sh -i']}
          vendor="claude"
          focused={focus.focused !== "sidebar"}
        />
      </box>
    </box>
  )
}

// Boot through the real React pane host: shared boot steps, persisted prefs
// seeding, live ui-prefs subscription, crash boundary, exit backstop.
await bootPaneHost({
  logContext: "mock-scene",
  providers: { kv: true, focus: true, notifications: true },
  setup: () => ({ root: () => <MockScene /> }),
})
