/**
 * `kanban.*` messages — the TUI kanban page (daemon-owned issues as a
 * Backlog / In progress / Done board).
 */

export const en = {
  title: "Kanban",
  /** Footer/legend hint. */
  hint: "r refresh · esc close",
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
}

export const zh: typeof en = {
  title: "看板",
  hint: "r 刷新 · esc 关闭",
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
}
