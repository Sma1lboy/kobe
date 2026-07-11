/**
 * `workspace.*` messages — the native opentui workspace host (`KOBE_TUI=1`):
 * the quit-confirm dialog and the "no task selected" empty state. English is
 * the source of truth; `zh: typeof en` keeps the shapes locked together.
 */

export const en = {
  quit: {
    confirmTitle: "Quit kobe?",
    confirmBody: "The daemon and task sessions keep running. This closes only the native workspace.",
    confirmLabel: "Quit",
  },
  empty: {
    selectTask: "Select a task with a worktree",
  },
  attention: {
    none: "No tasks waiting for input",
  },
  terminalComing: "Embedded terminal tab lands here (issue #16) — use the tmux path meanwhile.",
}

export const zh: typeof en = {
  quit: {
    confirmTitle: "退出 kobe？",
    confirmBody: "守护进程和任务会话会继续运行，这里只关闭原生工作区。",
    confirmLabel: "退出",
  },
  empty: {
    selectTask: "请选择一个带 worktree 的任务",
  },
  attention: {
    none: "没有等待输入的任务",
  },
  terminalComing: "嵌入终端标签页即将落位（issue #16）——期间请走 tmux 路径。",
}
