/**
 * kobe web shell — the Conductor 5-region grammar in the claude theme.
 * Left: task rail (TaskRail.tsx). Center: workspace tabs (engine, terminal,
 * notes, files). Right: task tools / Changes rail (ToolsPanel). Plus a top
 * brand/status bar and a bottom status bar.
 */

import { CircleHelp, PanelRight } from "lucide-react"
import { useEffect, useState } from "react"
import {
  closeSettings,
  openKeyboardHelp,
  openNewTask,
  openSettings,
  useGlobalUiState,
} from "../lib/global-ui.ts"
import { tailPath } from "../lib/path-format.ts"
import { useAppState } from "../lib/store.ts"
import { useTabsState } from "../lib/tabs.ts"
import { webTransportTopBarView } from "../lib/web-transport.ts"
import { AdoptDialog } from "./AdoptDialog.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"
import { DesktopWindowControls } from "./DesktopWindowControls.tsx"
import { SettingsPage } from "./SettingsPage.tsx"
import { TaskRail } from "./TaskRail.tsx"
import { ToolsPanel } from "./ToolsPanel.tsx"
import { ViewToggle } from "./ViewToggle.tsx"
import { WorkspaceTabs } from "./WorkspaceTabs.tsx"

function TopBar({
  onToggleTools,
  onShowHelp,
}: {
  onToggleTools: () => void
  onShowHelp: () => void
}) {
  const { daemonConnected, streamConnected, tasks } = useAppState()
  const { selectedTaskId } = useTabsState()
  const task = selectedTaskId
    ? tasks.find((item) => item.id === selectedTaskId)
    : null
  const transport = webTransportTopBarView({ daemonConnected, streamConnected })
  return (
    <header
      data-kobe-topbar
      className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-3"
    >
      <DesktopWindowControls />
      <span className="font-mono text-[13px] font-bold text-primary">
        [kobe]
      </span>
      <ViewToggle />
      {task ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className="max-w-56 truncate rounded bg-inset px-2 py-0.5 text-[11px] text-fg">
            {task.title || task.branch}
          </span>
          <span className="hidden max-w-40 truncate font-mono text-[11px] text-subtle md:inline">
            {task.branch}
          </span>
        </div>
      ) : (
        <span className="rounded bg-inset px-2 py-0.5 text-[11px] text-muted">
          Workspace
        </span>
      )}
      <div className="ml-auto flex items-center gap-3 text-[11px] text-subtle">
        <span
          className="hidden items-center gap-1.5 sm:flex"
          title={transport.title}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${transport.ok ? "bg-kobe-green" : "bg-kobe-yellow"}`}
          />
          <span>{transport.label}</span>
        </span>
        <button
          type="button"
          onClick={onShowHelp}
          className="hidden items-center text-muted transition-colors hover:text-fg sm:flex"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          <CircleHelp size={15} strokeWidth={1.8} />
        </button>
        {/* Tools rail toggle — only on narrow screens where the rail is a drawer. */}
        <button
          type="button"
          onClick={onToggleTools}
          className="flex items-center text-muted transition-colors hover:text-fg lg:hidden"
          aria-label="Toggle task tools"
          title="Task tools"
        >
          <PanelRight size={15} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  )
}

function StatusBar() {
  const { tasks, update } = useAppState()
  const { selectedTaskId } = useTabsState()
  const task = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId)
    : null
  const count = tasks.filter((t) => !t.archived).length
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 text-[11px] text-subtle">
      <span>
        {count} task{count === 1 ? "" : "s"}
      </span>
      {task && (
        <span className="min-w-0 truncate text-muted">
          {task.kind === "main" ? "project" : "worktree"} ·{" "}
          {tailPath(task.worktreePath, 54)}
        </span>
      )}
      <span className="ml-auto">
        {update?.latest ? `update ${update.latest} available` : "kobe web"}
      </span>
    </footer>
  )
}

export function AppShell() {
  const { settingsOpen } = useGlobalUiState()
  const [adoptOpen, setAdoptOpen] = useState(false)
  // The right tools rail is a fixed column at lg+, and a slide-in drawer on
  // narrow windows (where it used to vanish entirely, making rename/changes
  // unreachable on a phone).
  const [toolsOpen, setToolsOpen] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Escape closes the tools drawer — at the window level because focus is
      // rarely inside the drawer subtree, so a div-scoped onKeyDown wouldn't
      // see it. (The dialogs handle their own Escape; this is just the drawer.)
      if (event.key === "Escape") setToolsOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      <TopBar
        onToggleTools={() => setToolsOpen((cur) => !cur)}
        onShowHelp={openKeyboardHelp}
      />
      <DaemonBanner />
      <div className="flex min-h-0 flex-1">
        <TaskRail
          onOpenSettings={openSettings}
          onNewTask={openNewTask}
          onAdopt={() => setAdoptOpen(true)}
        />
        {settingsOpen ? (
          <SettingsPage onClose={closeSettings} />
        ) : (
          <WorkspaceTabs />
        )}
        {/* lg+: inline column. Narrow: off-canvas drawer toggled from TopBar. */}
        <div className="hidden lg:flex">
          <ToolsPanel />
        </div>
        {toolsOpen && (
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss; the × button + Escape are the keyboard paths.
          <div
            className="fixed inset-0 z-30 flex justify-end bg-black/50 lg:hidden"
            onClick={() => setToolsOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setToolsOpen(false)
            }}
            role="presentation"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Task tools"
              className="h-full w-80 max-w-[85vw] border-l border-line bg-bg shadow-2xl"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={() => {}}
            >
              <ToolsPanel drawer onClose={() => setToolsOpen(false)} />
            </div>
          </div>
        )}
      </div>
      <StatusBar />
      {adoptOpen && <AdoptDialog onClose={() => setAdoptOpen(false)} />}
    </div>
  )
}
