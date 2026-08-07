export interface EmptyTab {
  id: string
  kind: "empty"
  title: string
}

export interface VendorTab {
  id: string
  kind: "vendor"
  title: string
  /** Engine-task override: the PTY runs against THIS task while the tab
   *  lives in another task's strip (a worktree session surfaced in the
   *  project workspace). Absent = the tab's bucket task, the normal case. */
  taskId?: string
  /** Engine override for THIS tab only — the chat.tab.chooseEngine mirror;
   *  absent = task's engine. */
  vendor?: string
}

export interface TerminalTab {
  id: string
  kind: "terminal"
  title: string
}

/** Structured engine-history view (read-only chat render, not a PTY). */
export interface TranscriptTab {
  id: string
  kind: "transcript"
  title: string
}

export interface FilePreviewTab {
  id: string
  kind: "file"
  title: string
  path: string
}

export type WorkspaceTab =
  | EmptyTab
  | VendorTab
  | TerminalTab
  | TranscriptTab
  | FilePreviewTab

export interface TabsState {
  selectedTaskId: string | null
  /** taskId → its workspace tabs, in order. */
  tabsByTask: Record<string, WorkspaceTab[]>
  /** taskId → active tab id. */
  activeByTask: Record<string, string>
  /** taskId → horizontally split tab id shown on the right side. */
  splitByTask: Record<string, string>
}
