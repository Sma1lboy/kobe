/**
 * `history.*` messages — the `kobe history` read-only engine-history pane
 * (beta: shown in the engine pane slot when an archived task is opened).
 * English is the source of truth; `zh: typeof en` keeps the shapes locked.
 */

export const en = {
  empty: "No engine history for this task.",
  loading: "loading…",
  sessionLabel: "Session",
  archivedTag: "ARCHIVED",
  hint: "[ ] session · j/k scroll · q close",
  role: {
    user: "USER",
    assistant: "ASSISTANT",
    system: "SYSTEM",
  },
  thinking: "thinking",
}

export const zh: typeof en = {
  empty: "此任务没有引擎历史记录。",
  loading: "加载中…",
  sessionLabel: "会话",
  archivedTag: "已归档",
  hint: "[ ] 会话 · j/k 滚动 · q 关闭",
  role: {
    user: "用户",
    assistant: "助手",
    system: "系统",
  },
  thinking: "思考",
}
