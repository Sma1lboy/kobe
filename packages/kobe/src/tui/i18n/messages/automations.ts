/**
 * `automations.*` messages — the scheduled-automations page. English is the
 * source of truth; `zh: typeof en` keeps the shapes locked together.
 */

export const en = {
  title: "AUTOMATIONS",
  holdingDaemon: "keeping the daemon awake",
  notHolding: "none active",
  paused: "paused",
  empty: "No automations scheduled.",
  emptyHint: "Create one with `kobe api automation-create --repo . --name N --prompt P --schedule CRON`.",
  precheck: "precheck: {command}",
  recentRuns: "RECENT RUNS",
  noRuns: "Not run yet.",
  running: "Running {name}…",
  ranWith: "{name}: {status}",
  deleteTitle: "Delete automation?",
  deleteBody: "{name} and its run history will be removed. Tasks it already created are untouched.",
  deleteButton: "Delete",
  keys: "j/k move · e pause/resume · s run now · enter open last run · r refresh · esc close",
}

export const zh: typeof en = {
  title: "自动化",
  holdingDaemon: "正在保持守护进程常驻",
  notHolding: "无启用项",
  paused: "已暂停",
  empty: "还没有定时任务。",
  emptyHint: "用 `kobe api automation-create --repo . --name N --prompt P --schedule CRON` 创建。",
  precheck: "预检：{command}",
  recentRuns: "最近执行",
  noRuns: "尚未执行。",
  running: "正在运行 {name}…",
  ranWith: "{name}：{status}",
  deleteTitle: "删除这条自动化？",
  deleteBody: "将删除 {name} 及其执行记录。它已经创建的任务不受影响。",
  deleteButton: "删除",
  keys: "j/k 移动 · e 暂停/恢复 · s 立即运行 · enter 打开最近一次 · r 刷新 · esc 关闭",
}
