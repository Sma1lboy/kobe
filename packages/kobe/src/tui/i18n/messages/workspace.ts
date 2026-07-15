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
    none: "No tasks waiting for input",
  },
  inbox: {
    title: "INBOX",
    empty: "No pending attention",
    unavailable: "unavailable",
    unavailableTitle: "Chat tab unavailable",
    unavailableBody: "This task or chat tab no longer exists. The Inbox item stays here until you delete it.",
    openHint: "enter open",
    deleteHint: "d delete",
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
    none: "没有等待输入的任务",
  },
  inbox: {
    title: "收件箱",
    empty: "暂无待处理",
    unavailable: "目标不可用",
    unavailableTitle: "聊天标签页不可用",
    unavailableBody: "这个任务或聊天标签页已不存在。该条目会保留在收件箱中，直到你手动删除。",
    openHint: "enter 打开",
    deleteHint: "d 删除",
  },
  terminalComing: "嵌入终端正在启动……",
}
