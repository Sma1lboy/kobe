/**
 * `automations.*` messages — the scheduled-automations page. English is the
 * source of truth; `zh: typeof en` keeps the shapes locked together.
 */

export const en = {
  title: "ROUTINES",
  holdingDaemon: "keeping the daemon awake",
  notHolding: "none active",
  paused: "paused",
  newTitle: "New routine",
  fieldName: "name",
  fieldRepo: "repo",
  fieldPrompt: "prompt",
  fieldSchedule: "schedule (five-field cron)",
  namePlaceholder: "weekday dependency audit",
  promptPlaceholder: "Audit dependencies and summarize risky changes.",
  needRepo: "Open a project first — a routine runs in one.",
  cronInvalid: "not a five-field cron",
  cronField: {
    minute: "min",
    hour: "hour",
    dayOfMonth: "day",
    month: "month",
    dayOfWeek: "weekday",
  },

  cronNever: "valid, but never fires",
  missing: {
    name: "Give it a name.",
    repo: "Pick a project.",
    prompt: "Say what it should do.",
    schedule: "That schedule will not run.",
  },

  empty: "No routines scheduled.",
  emptyHint: "Press n to create one.",
  precheck: "precheck: {command}",
  recentRuns: "RECENT RUNS",
  noRuns: "Not run yet.",
  noSelection: "A routine runs its prompt in a project on a schedule.",
  running: "Running {name}…",
  ranWith: "{name}: {status}",
  runNow: "[ run now ]",
  runNowHint: "try it without waiting for the schedule",
  deleteTitle: "Delete routine?",
  deleteBody: "{name} and its run history will be removed. Tasks it already created are untouched.",
  deleteButton: "Delete",
}

export const zh: typeof en = {
  title: "例行任务",
  holdingDaemon: "正在保持守护进程常驻",
  notHolding: "无启用项",
  paused: "已暂停",
  newTitle: "新建例行任务",
  fieldName: "名称",
  fieldRepo: "仓库",
  fieldPrompt: "提示词",
  fieldSchedule: "调度（五段 cron）",
  namePlaceholder: "工作日依赖审计",
  promptPlaceholder: "审计依赖并总结有风险的变更。",
  needRepo: "先打开一个项目——例行任务要跑在某个项目里。",
  cronInvalid: "不是合法的五段 cron",
  cronField: {
    minute: "分",
    hour: "时",
    dayOfMonth: "日",
    month: "月",
    dayOfWeek: "星期",
  },

  cronNever: "语法合法，但永远不会触发",
  missing: {
    name: "起个名字。",
    repo: "选一个项目。",
    prompt: "说明它要做什么。",
    schedule: "这个调度不会触发。",
  },

  empty: "还没有例行任务。",
  emptyHint: "按 n 新建一条。",
  precheck: "预检：{command}",
  recentRuns: "最近执行",
  noRuns: "尚未执行。",
  noSelection: "例行任务会按调度在某个项目里跑它的提示词。",
  running: "正在运行 {name}…",
  ranWith: "{name}：{status}",
  runNow: "[ 立即运行 ]",
  runNowHint: "不等调度，直接试一次",
  deleteTitle: "删除这条例行任务？",
  deleteBody: "将删除 {name} 及其执行记录。它已经创建的任务不受影响。",
  deleteButton: "删除",
}
