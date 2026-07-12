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
      worktree: "New worktree — open its task session",
      worktreeBg: "New worktree — stay here (task under the project group)",
      project: "Project checkout — no worktree",
    },
    startLegend: "enter/ctrl+enter start · tab fields · ←→ engine · ↑↓ workspace · esc save & close",
    openLegend: "ctrl+enter open the linked session · tab fields · esc save & close",
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
      worktree: "新建 worktree——打开它的任务会话",
      worktreeBg: "新建 worktree——留在原地(任务挂在项目组下)",
      project: "项目主目录——不建 worktree",
    },
    startLegend: "enter/ctrl+enter 启动 · tab 切字段 · ←→ 引擎 · ↑↓ 工作区 · esc 保存关闭",
    openLegend: "ctrl+enter 打开已关联会话 · tab 切字段 · esc 保存关闭",
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
