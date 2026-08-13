/**
 * `help.*` messages. English is the source of truth; `zh: typeof en` keeps
 * the shapes locked together. Filled during the TUI i18n migration.
 */

export const en = {
  /** Dialog title */
  title: "Rove — keybindings",
  /** Close / cancel hint */
  esc: "esc",
  commandLayer: "{prefix} — more Rove commands",
  escCancel: "esc cancel",
  focused: "Focused: {surface}",
  allBindings: "All keybinding contexts",
  grammar: "Use keys here · one-press Rove shortcuts · {prefix} for more commands",
  disabled: "prefix disabled",
  here: "HERE — only in {surface}",
  direct: "ONE PRESS — Rove shortcuts",
  afterPrefix: "AFTER PREFIX — more Rove commands",
  otherPane: "OTHER PANE — {surface}",
}

export const zh: typeof en = {
  title: "Rove — 快捷键",
  esc: "esc",
  commandLayer: "{prefix} — 更多 Rove 命令",
  escCancel: "esc 取消",
  focused: "当前焦点：{surface}",
  allBindings: "所有快捷键上下文",
  grammar: "当前区域直接按 · Rove 单次快捷键 · {prefix} 打开更多命令",
  disabled: "Prefix 已禁用",
  here: "当前区域 — 仅在{surface}",
  direct: "一次按下 — Rove 快捷键",
  afterPrefix: "按下 Prefix 后 — 更多 Rove 命令",
  otherPane: "其他区域 — {surface}",
}
