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
  keys: "j/k move · enter start work · a mine · tab project · r refresh · esc close",
}

export const zh: typeof en = {
  title: "议题",
  noRepo: "无项目",
  empty: "没有开放的议题。",
  assignedFilter: "分配给我的",
  starting: "正在开始处理 #{number}…",
  startedNoEngine: "已创建 {title}，但引擎没有启动。",
  keys: "j/k 移动 · enter 开始处理 · a 只看我的 · tab 切项目 · r 刷新 · esc 关闭",
}
