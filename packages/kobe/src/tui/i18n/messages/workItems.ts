/**
 * `workItems.*` messages — the external-tracker (GitHub issues) page. English
 * is the source of truth; `zh: typeof en` keeps the shapes locked together.
 */

export const en = {
  title: "ISSUES",
  noRepo: "no project",
  empty: "No open issues.",
  assignedFilter: "assigned to me",
  starting: "Starting work on #{number}…",
  startedNoEngine: "Created {title}, but its engine did not start.",
}

export const zh: typeof en = {
  title: "议题",
  noRepo: "无项目",
  empty: "没有开放的议题。",
  assignedFilter: "分配给我的",
  starting: "正在开始处理 #{number}…",
  startedNoEngine: "已创建 {title}，但引擎没有启动。",
}
