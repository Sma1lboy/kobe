/**
 * `help.*` messages. English is the source of truth; `zh: typeof en` keeps
 * the shapes locked together. Filled during the TUI i18n migration.
 */

export const en = {
  /** Dialog title */
  title: "kobe — keybindings",
  /** Close / cancel hint */
  esc: "esc",
  commandLayer: "{prefix} — more Kobe commands",
  escCancel: "esc cancel",
  focused: "Focused: {surface}",
  allBindings: "All keybinding contexts",
  grammar: "Use keys here · one-press Kobe shortcuts · {prefix} for more commands",
  disabled: "prefix disabled",
  here: "HERE — only in {surface}",
  direct: "ONE PRESS — Kobe shortcuts",
  afterPrefix: "AFTER PREFIX — more Kobe commands",
  otherPane: "OTHER PANE — {surface}",
  coach: {
    title: "Keyboard tour {step}/2",
    skip: "click to dismiss",
    step0: "In the Sidebar, use {nav} to move and {open} to open a task. Bare keys belong to the focused pane.",
    step1: "Press {key} to reveal every available second key, then choose a command or press esc.",
  },
}

export const zh: typeof en = {
  title: "kobe — 快捷键",
  esc: "esc",
  commandLayer: "{prefix} — 更多 Kobe 命令",
  escCancel: "esc 取消",
  focused: "当前焦点：{surface}",
  allBindings: "所有快捷键上下文",
  grammar: "当前区域直接按 · Kobe 单次快捷键 · {prefix} 打开更多命令",
  disabled: "Prefix 已禁用",
  here: "当前区域 — 仅在{surface}",
  direct: "一次按下 — Kobe 快捷键",
  afterPrefix: "按下 Prefix 后 — 更多 Kobe 命令",
  otherPane: "其他区域 — {surface}",
  coach: {
    title: "快捷键导览 {step}/2",
    skip: "点击关闭",
    step0: "在侧边栏用 {nav} 移动、{open} 打开任务。裸键只属于当前聚焦区域。",
    step1: "按 {key} 查看当前可用的所有第二键，然后选择命令或按 esc 取消。",
  },
}
