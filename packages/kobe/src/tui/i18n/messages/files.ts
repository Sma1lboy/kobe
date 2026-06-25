/**
 * `files.*` messages. English is the source of truth; `zh: typeof en` keeps
 * the shapes locked together. Filled during the TUI i18n migration.
 */

export const en = {
  tabs: {
    all: "All",
    changes: "Changes",
  },
  actions: {
    zen: "Zen",
    createPR: "Create PR",
  },
  legend: {
    changes: "M modified · A added · D deleted · ? untracked",
  },
  empty: {
    noTask: "(no task — press n to create)",
    noFiles: "(empty worktree)",
    noChanges: "(no changes — clean worktree)",
  },
  error: {
    retryHint: "press r to retry",
    notGitRepo: "not a git repository",
    pathMissing: "worktree path is missing",
    permissionDenied: "permission denied",
    gitNotInstalled: "git is not installed",
    gitFailed: "git command failed",
  },
  footer: {
    openHint: "↵ open",
  },
}

export const zh: typeof en = {
  tabs: {
    all: "全部",
    changes: "改动",
  },
  actions: {
    zen: "专注模式",
    createPR: "创建 PR",
  },
  legend: {
    changes: "M 已修改 · A 已添加 · D 已删除 · ? 未跟踪",
  },
  empty: {
    noTask: "（暂无任务 — 按 n 创建）",
    noFiles: "（worktree 为空）",
    noChanges: "（无改动 — worktree 干净）",
  },
  error: {
    retryHint: "按 r 重试",
    notGitRepo: "不是 git 仓库",
    pathMissing: "worktree 路径不存在",
    permissionDenied: "权限不足",
    gitNotInstalled: "未安装 git",
    gitFailed: "git 命令失败",
  },
  footer: {
    openHint: "↵ 打开",
  },
}
