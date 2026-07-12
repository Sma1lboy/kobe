/**
 * `kanban.*` messages — the TUI kanban page (daemon-owned issues as a
 * Backlog / In progress / Done board) and its issue-detail drawer.
 */

export const en = {
  title: "Kanban",
  /** Footer/legend hint. */
  hint: "tab project · ←↓↑→ card · enter detail · r refresh · esc close",
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
    noDescription: "No description.",
    engine: "engine  ←/→",
    workspace: "workspace  ↑/↓",
    placement: {
      worktree: "New worktree — open its task session",
      worktreeBg: "New worktree — stay here (task under the project group)",
      project: "Project checkout — no worktree",
    },
    startLegend: "enter start · ←→ engine · ↑↓ workspace · paste/ctrl+v attach image · esc close",
    openLegend: "enter open the linked session · esc close",
    doneNote: "Done stories have nothing left to start.",
    /** Toast after a background start. `{title}` = the spawned task title. */
    startedBackground: "Started in background: {title}",
  },
}

export const zh: typeof en = {
  title: "看板",
  hint: "tab 切项目 · ←↓↑→ 选卡片 · enter 详情 · r 刷新 · esc 关闭",
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
  detail: {
    status: {
      open: "待办",
      doing: "进行中",
      hold: "搁置",
      done: "已完成",
    },
    created: "创建于 {date}",
    linked: "已关联会话",
    noDescription: "暂无描述。",
    engine: "引擎  ←/→",
    workspace: "工作区  ↑/↓",
    placement: {
      worktree: "新建 worktree——打开它的任务会话",
      worktreeBg: "新建 worktree——留在原地(任务挂在项目组下)",
      project: "项目主目录——不建 worktree",
    },
    startLegend: "enter 启动 · ←→ 引擎 · ↑↓ 工作区 · 粘贴/ctrl+v 附图 · esc 关闭",
    openLegend: "enter 打开已关联会话 · esc 关闭",
    doneNote: "已完成的 story 无需启动。",
    startedBackground: "已在后台启动:{title}",
  },
}
