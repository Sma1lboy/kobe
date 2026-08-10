/**
 * `hints.*` messages — the keyboard-discoverability hints: the status-bar
 * micro-hint and the first-use pane hint lines. English is the source of
 * truth; `zh: typeof en` keeps the shapes locked together.
 *
 * Every `{key}` placeholder is filled from the LIVE keymap at render time
 * (chords may be rebound or disabled) — never hardcode a chord here.
 */

export const en = {
  status: {
    /** {key} = the live prefix first stroke — opens the command layer */
    commands: "{key} commands",
    /** {key} = the live help chord — full keybinding reference */
    help: "{key} help",
    /** {key} = the live escape hatch out of the embedded terminal */
    sidebar: "{key} sidebar",
    /** Label of the clickable footer settings button (brackets added in code) */
    settings: "settings",
  },
  pane: {
    move: "move",
    open: "open",
    fold: "fold",
    diff: "diff",
  },
}

export const zh: typeof en = {
  status: {
    commands: "{key} 命令",
    help: "{key} 帮助",
    sidebar: "{key} 侧栏",
    settings: "设置",
  },
  pane: {
    move: "移动",
    open: "打开",
    fold: "折叠",
    diff: "差异",
  },
}
