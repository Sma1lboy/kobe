/**
 * Shared mock task fixtures for the sidebar smoke hosts (issue #15, G3).
 * Framework-free, so the React mock hosts (e.g.
 * `src/tui-react/panes/sidebar/mock-host.tsx`) can render the same
 * synthetic task list without a daemon, tasks.json, or real worktrees.
 * Paths point under /mock so the git pollers fail closed (chips hidden).
 */

import type { Task } from "@/types/task"
import { toTaskId } from "@/types/task"

export const MOCK_SIDEBAR_REPO = "/mock/repos/kobe"

/** A representative task list: project row, running/pinned/backlog/archived. */
export function seedSidebarTasks(): readonly Task[] {
  const ts = "2026-07-01T00:00:00.000Z"
  const base = {
    repo: MOCK_SIDEBAR_REPO,
    createdAt: ts,
    updatedAt: ts,
  }
  // Enough sibling projects to overflow the PROJECTS scrollbox — the mock
  // host is the visual bench for project-list tunes (scrollbar, budgets).
  const extraProjects: Task[] = [
    "brand-studio",
    "foxscreen",
    "mc-launcher",
    "agent-deck",
    "tabby",
    "sma1lboy.me",
    "foxychat-server",
  ].map((name) => ({
    ...base,
    repo: `/mock/repos/${name}`,
    id: toTaskId(`mock-main-${name}`),
    title: name,
    branch: "",
    worktreePath: `/mock/repos/${name}`,
    kind: "main" as const,
    status: "backlog" as const,
    archived: false,
  }))
  return [
    ...extraProjects,
    {
      ...base,
      id: toTaskId("mock-main"),
      title: "kobe",
      branch: "",
      worktreePath: MOCK_SIDEBAR_REPO,
      kind: "main",
      status: "backlog",
      archived: false,
    },
    {
      ...base,
      id: toTaskId("mock-alpha"),
      title: "Port sidebar to React",
      branch: "feat/react-sidebar-pane",
      worktreePath: "/mock/worktrees/react-sidebar",
      kind: "task",
      status: "in_progress",
      archived: false,
      pinned: true,
      vendor: "claude",
    },
    {
      ...base,
      id: toTaskId("mock-beta"),
      title: "Fix transcript cache identity",
      branch: "fix/transcript-cache",
      worktreePath: "/mock/worktrees/transcript-cache",
      kind: "task",
      status: "in_review",
      archived: false,
      vendor: "claude",
      prStatus: {
        provider: "github",
        lifecycle: "open",
        checkState: "passing",
      },
    },
    {
      ...base,
      id: toTaskId("mock-gamma"),
      title: "调研 tmux 布局持久化",
      branch: "spike/tmux-layout",
      worktreePath: "/mock/worktrees/tmux-layout",
      kind: "task",
      status: "backlog",
      archived: false,
      vendor: "codex",
    },
    {
      ...base,
      repo: "/mock/repos/brand-studio",
      id: toTaskId("mock-brand-logo"),
      title: "hex-fox logo refresh",
      branch: "logo/concepts",
      worktreePath: "/mock/worktrees/brand-logo",
      kind: "task",
      status: "in_progress",
      archived: false,
      vendor: "claude",
    },
    {
      ...base,
      repo: "/mock/repos/foxscreen",
      id: toTaskId("mock-fox-recorder"),
      title: "add branded recorder overlay",
      branch: "chore/add-branding",
      worktreePath: "/mock/worktrees/fox-recorder",
      kind: "task",
      status: "backlog",
      archived: false,
      vendor: "codex",
    },
    {
      ...base,
      id: toTaskId("mock-archived"),
      title: "Old shipped experiment",
      branch: "feat/old-experiment",
      worktreePath: "/mock/worktrees/old-experiment",
      kind: "task",
      status: "done",
      archived: true,
      vendor: "claude",
    },
  ]
}
