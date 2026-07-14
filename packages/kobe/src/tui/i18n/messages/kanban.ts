/**
 * `kanban.*` messages — the TUI kanban page (daemon-owned issues as a
 * Backlog / In progress / Done board) and its issue-detail drawer.
 */

export const en = {
  title: "Kanban",
  /** Footer/legend hint. */
  hint: "tab project · ←↓↑→ card · enter detail · n new · d delete · r refresh · esc close",
  loading: "Loading issues…",
  /** No saved projects / no tasks to derive repos from. */
  noRepos: "No projects yet — create a task first.",
  /** A repo section with zero issues. */
  empty: "No issues — agents file them via `kobe api issue-create`.",
  column: {
    backlog: "Backlog",
    inProgress: "In progress",
    done: "Done",
  },
  /** Done-column overflow note. `{count}` = hidden issue count. */
  more: "+{count} more",
  /** Badge on a Backlog card whose stored status is `hold`. */
  hold: "hold",
  /** In-progress card badge: the linked task's engine finished a turn
   *  (waiting on review/input) but the story isn't `done` yet. */
  turnComplete: "turn done",
  detail: {
    status: {
      open: "open",
      doing: "doing",
      hold: "hold",
      done: "done",
    },
    /** `{date}` = the issue's created date (day-granular). */
    created: "created {date}",
    /** Badge for a story already linked to a task. */
    linked: "linked to a session",
    /** BOLD CAPS section headers in the drawer. */
    titleLabel: "TITLE",
    description: "DESCRIPTION",
    noDescription: "No description.",
    /** Muted hint beside the description header. */
    attachHint: "paste a path / ctrl+v screenshot → inserts an image placeholder",
    engine: "ENGINE",
    workspace: "WORKSPACE",
    placement: {
      worktree: "New worktree task — its own workspace",
      projectWorktree: "New worktree — as a chattab in the project workspace",
      project: "Project checkout — a new chattab, no worktree",
    },
    /** The follow-or-stay toggle (orthogonal to placement). */
    jumpLabel: "AFTER START",
    jump: {
      stay: "Stay on the board",
      follow: "Jump to the session",
    },
    startLegend: "enter/ctrl+enter start · tab fields · ←→ engine · ↑↓ workspace · esc save & close",
    /** Linked-story jump action: section header + the button itself. */
    sessionLabel: "SESSION",
    openAction: "Open the linked session ↵",
    openLegend: "enter/ctrl+enter open the linked session · tab fields · esc save & close",
    doneNote: "Done stories have nothing left to start · esc save & close",
    /** Toast after a background start. `{title}` = the spawned task title. */
    startedBackground: "Started in background: {title}",
    /** Create-mode header + legend (`n` on the board). */
    newStory: "NEW STORY",
    createLegend: "ctrl+s save · enter/ctrl+enter save & start · tab fields · esc cancel",
  },
  confirmDelete: {
    /** `{id}` = the issue number. */
    title: "Delete story #{id}?",
    /** `{title}` = the issue title. Deletes ONLY the record. */
    body: "“{title}” will be removed from the tracker. A linked task, branch, or worktree is left untouched.",
  },
}

export const zh: typeof en = {
  title: "看板",
  hint: "tab 切项目 · ←↓↑→ 选卡片 · enter 详情 · n 新建 · d 删除 · r 刷新 · esc 关闭",
  loading: "正在加载 issues…",
  noRepos: "还没有项目——先创建一个任务。",
  empty: "暂无 issue——agent 可通过 `kobe api issue-create` 创建。",
  column: {
    backlog: "待办",
    inProgress: "进行中",
    done: "已完成",
  },
  more: "还有 {count} 条",
  hold: "搁置",
  turnComplete: "回合完成",
  detail: {
    status: {
      open: "待办",
      doing: "进行中",
      hold: "搁置",
      done: "已完成",
    },
    created: "创建于 {date}",
    linked: "已关联会话",
    titleLabel: "标题",
    description: "描述",
    noDescription: "暂无描述。",
    attachHint: "粘贴路径 / ctrl+v 贴截图 → 插入图片占位行",
    engine: "引擎",
    workspace: "工作区",
    placement: {
      worktree: "新建 worktree 任务——独立工作区",
      projectWorktree: "新建 worktree——作为项目工作区里的 chattab",
      project: "项目主目录——新开 chattab,不建 worktree",
    },
    jumpLabel: "启动后",
    jump: {
      stay: "留在看板",
      follow: "跳转到会话",
    },
    startLegend: "enter/ctrl+enter 启动 · tab 切字段 · ←→ 引擎 · ↑↓ 工作区 · esc 保存关闭",
    sessionLabel: "会话",
    openAction: "打开关联会话 ↵",
    openLegend: "enter/ctrl+enter 打开已关联会话 · tab 切字段 · esc 保存关闭",
    doneNote: "已完成的 story 无需启动 · esc 保存关闭",
    startedBackground: "已在后台启动:{title}",
    newStory: "新建 STORY",
    createLegend: "ctrl+s 仅保存 · enter/ctrl+enter 保存并启动 · tab 切字段 · esc 取消",
  },
  confirmDelete: {
    title: "删除 story #{id}?",
    body: "「{title}」将从 tracker 中移除。已关联的任务、分支、worktree 不受影响。",
  },
}
