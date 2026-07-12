/**
 * `tasks.*` messages. English is the source of truth; `zh: typeof en` keeps
 * the shapes locked together. Filled during the TUI i18n migration.
 */

export const en = {
  /** View-switcher tab labels */
  view: {
    workspace: "Workspace",
    archives: "Archives",
  },
  /** Section headers */
  header: {
    projects: "PROJECTS",
    tasks: "TASKS",
  },
  /** Search bar */
  search: {
    placeholder: "fuzzy filter",
  },
  /** Inline chip while move/reorder mode is active */
  moveChip: " move",
  /** Empty-state messages */
  empty: {
    noMatchSearch: "No matching tasks — esc to clear.",
    noActiveProject: "No active tasks for this project.",
    noArchivedProject: "No archived tasks for this project.",
    noActive: "No active tasks — press n or [+] to create one.",
    noArchived: "No archived tasks.",
  },
  /** In-list hint shown at the bottom of the Archives view */
  archiveHint: "a to unarchive",
  /** Row-view status labels (shown in subtitle when no branch) */
  status: {
    done: "done",
    inReview: "in review",
    working: "working",
    backlog: "—",
    canceled: "canceled",
    error: "error",
  },
  /** Row-view engine activity labels (shown in subtitle, override branch) */
  activity: {
    rateLimited: "rate limited",
    permissionNeeded: "needs permission",
    error: "error",
  },
  /** Row-view special subtitle words */
  subtitle: {
    noTracking: "no activity tracking",
    materializing: "materializing",
  },
  /** ShortcutHints legend */
  hints: {
    /** Collapsible legend header (folded / unfolded) */
    headerFolded: "── keys ?▸ ──",
    headerUnfolded: "── keys ?▾ ──",
    /** In-pane action labels */
    fullHelp: "full help",
    newTask: "new task",
    settings: "settings",
    open: "open",
    focusEngine: "focus engine",
    openWorktree: "open wt",
    delete: "delete",
    views: "views",
    project: "project",
    /** Move/reorder mode labels */
    reorder: "reorder",
    done: "done",
  },
  /** Set-branch (re-branch) dialog — lists the repo's local branches with
      filter-as-you-type; typing a new name renames the task's branch. */
  reBranch: {
    title: "Set branch",
    fieldLabel: "branch",
    hintNoBranches: "(no local branches — type a new name)",
    hintNoMatch: "(no match — enter renames to this branch)",
    footer: "↑↓ pick · enter set · esc cancel",
  },
  /** Toast / error messages */
  toast: {
    noDaemonWorktree: "No daemon running — can't create the worktree",
    noDaemonOpen: "No daemon running — can't open this task",
    noEditor: "No editor found — set KOBE_OPEN_EDITOR (e.g. 'code', 'cursor', 'nvim')",
    openWorktreeFailed: "Couldn't open worktree with {label}",
    sessionStartFailed: "Couldn't start this task's session",
    moveTaskFailed: "Couldn't move task: {message}",
    alreadyLatest: "Already on the latest version (v{version})",
    worktreeErrorNotGit:
      "This project isn't a git repo yet — a task needs a git branch. Run `git init` (+ a first commit) in the project, then open the task. Non-git support is coming.",
    worktreeErrorGeneric: "Couldn't create the worktree: {message}",
  },
}

export const zh: typeof en = {
  view: {
    workspace: "工作区",
    archives: "归档",
  },
  header: {
    projects: "项目",
    tasks: "任务",
  },
  search: {
    placeholder: "模糊搜索",
  },
  moveChip: " 移动",
  empty: {
    noMatchSearch: "无匹配任务——按 esc 清除。",
    noActiveProject: "该项目暂无活跃任务。",
    noArchivedProject: "该项目暂无归档任务。",
    noActive: "暂无活跃任务——按 n 或 [+] 新建。",
    noArchived: "暂无归档任务。",
  },
  archiveHint: "a 取消归档",
  status: {
    done: "已完成",
    inReview: "审核中",
    working: "进行中",
    backlog: "—",
    canceled: "已取消",
    error: "错误",
  },
  activity: {
    rateLimited: "请求受限",
    permissionNeeded: "等待授权",
    error: "错误",
  },
  subtitle: {
    noTracking: "不跟踪活动",
    materializing: "正在创建 worktree",
  },
  hints: {
    headerFolded: "── 快捷键 ?▸ ──",
    headerUnfolded: "── 快捷键 ?▾ ──",
    fullHelp: "完整帮助",
    newTask: "新建任务",
    settings: "设置",
    open: "打开",
    focusEngine: "聚焦引擎",
    openWorktree: "打开 worktree",
    delete: "删除",
    views: "视图",
    project: "项目",
    reorder: "重新排序",
    done: "完成",
  },
  reBranch: {
    title: "设置分支",
    fieldLabel: "分支",
    hintNoBranches: "（没有本地分支——输入新名称）",
    hintNoMatch: "（无匹配——回车将分支重命名为此名）",
    footer: "↑↓ 选择 · enter 设置 · esc 取消",
  },
  toast: {
    noDaemonWorktree: "守护进程未运行——无法创建 worktree",
    noDaemonOpen: "守护进程未运行——无法打开此任务",
    noEditor: "未找到编辑器——请设置 KOBE_OPEN_EDITOR（如 'code'、'cursor'、'nvim'）",
    openWorktreeFailed: "无法用 {label} 打开 worktree",
    sessionStartFailed: "无法启动此任务的会话",
    moveTaskFailed: "无法移动任务：{message}",
    alreadyLatest: "已是最新版本（v{version}）",
    worktreeErrorNotGit:
      "该项目尚非 git 仓库——任务需要 git 分支。请在项目中执行 `git init`（+ 首次提交）后再打开任务。非 git 项目的支持即将推出。",
    worktreeErrorGeneric: "无法创建 worktree：{message}",
  },
}
