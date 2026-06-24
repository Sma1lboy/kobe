/**
 * `quickTask.*` messages. English is the source of truth; `zh: typeof en` keeps
 * the shapes locked together. Filled during the TUI i18n migration.
 */

export const en = {
  /** Dialog header: "Quick task · <repo>" */
  title: "Quick task · {repoLabel}",
  /** Cancel / close hint */
  esc: "esc",
  /** Prompt field label */
  promptLabel: "prompt",
  /** Prompt input placeholder */
  promptPlaceholder: "what should this task do?",
  /** Engine field label */
  engineLabel: "engine",
  /** Branch field label */
  branchLabel: "branch",
  /** Footer hint legend */
  legend: "enter create · tab field · ctrl+e engine · esc cancel",
}

export const zh: typeof en = {
  title: "快速任务 · {repoLabel}",
  esc: "esc",
  promptLabel: "提示词",
  promptPlaceholder: "这个任务要做什么？",
  engineLabel: "引擎",
  branchLabel: "分支",
  legend: "enter 创建 · tab 切换字段 · ctrl+e 切换引擎 · esc 取消",
}
