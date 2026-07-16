/**
 * `workspace.*` messages — the PureTUI Workspace Host:
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
    none: "No available Inbox items",
  },
  inbox: {
    title: "INBOX",
    empty: "No pending attention",
    unavailable: "unavailable",
    openHint: "enter open",
    deleteHint: "d delete",
    state: {
      done: "done",
      needsInput: "needs input",
      error: "error",
      rateLimited: "rate limited",
    },
  },
  terminalComing: "Embedded terminal is starting...",
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
    none: "收件箱中没有可打开的项目",
  },
  inbox: {
    title: "收件箱",
    empty: "暂无待处理",
    unavailable: "目标不可用",
    openHint: "enter 打开",
    deleteHint: "d 删除",
    state: {
      done: "完成",
      needsInput: "需要输入",
      error: "出错",
      rateLimited: "限流",
    },
  },
  terminalComing: "嵌入终端正在启动……",
}
