/**
 * `onboarding.*` messages — the first-run wizard (`src/cli/onboarding.ts` +
 * `src/tui-react/onboarding/host.tsx`). English is the source of truth;
 * `zh: typeof en` keeps the shapes locked together.
 */

export const en = {
  /** Wizard header */
  title: "Welcome to Rove",
  /** One-liner under the header */
  subtitle: "Two quick questions before your first launch.",
  /** Step 1 question; {shell} is the detected shell name (zsh/bash/fish) */
  completionsQuestion: "Install shell completions for {shell}?",
  /** Step 1 explanation */
  completionsExplain: "Tab-completes rove subcommands. One line is added to your shell config.",
  /** Step 2 question */
  skillQuestion: "Install the Rove agent skill?",
  /** Step 2 explanation */
  skillExplain: "Teaches coding agents (Claude Code, Codex) to drive Rove from the shell via `rove api`.",
  /** Recommended option */
  optionYes: "Yes (recommended)",
  /** Decline option */
  optionNo: "No",
  /** Key legend at the bottom of the wizard */
  legend: "↑↓ select · enter confirm · q skip setup",
  /** Final informational page: heading. Every {placeholder} below is filled from the LIVE keymap. */
  keysTitle: "Keyboard basics",
  /** {nav} sidebar move keys, {open} select key */
  keysBare: "Bare keys act in the focused pane — {nav} moves, {open} opens.",
  /** {newTab} new-tab chord, {focusNext} pane-cycle chord */
  keysOnePress: "A few one-press chords are Rove's own — {newTab} new tab, {focusNext} next pane.",
  /** {prefix} the prefix first stroke */
  keysPrefix: "{prefix} opens the command map — hold it a beat and a guide appears.",
  /** {help} the help chord */
  keysHelp: "{help} shows the full live reference anytime.",
  /** Legend on the keys page */
  keysLegend: "enter finish",
  /** Post-wizard: completions line was written; {path} is the rc/completions file */
  appliedCompletions: "✓ completions hooked into {path} (takes effect in new shells)",
  /** Post-wizard: completions declined; {command} re-runs it later */
  skippedCompletions: "· completions skipped — run `{command}` anytime",
  /** Post-wizard: about to run the skill installer; {command} is the npx command */
  installingSkill: "installing the Rove agent skill ({command})…",
  /** Post-wizard: skill installer failed; {command} retries it */
  skillFailed: "! skill install failed — retry with `{command}`",
  /** Post-wizard: skill declined; {command} re-runs it later */
  skippedSkill: "· agent skill skipped — run `{command}` anytime",
  /** Final ready banner */
  ready: "You're ready to go!",
  /** Final hint: how to start */
  readyHint: "Run `rove` to launch the TUI.",
}

export const zh: typeof en = {
  title: "欢迎使用 Rove",
  subtitle: "首次启动前，先回答两个小问题。",
  completionsQuestion: "为 {shell} 安装 shell 补全吗？",
  completionsExplain: "让 rove 子命令支持 Tab 补全，会在你的 shell 配置里加一行。",
  skillQuestion: "安装 Rove agent skill 吗？",
  skillExplain: "教会编码 agent（Claude Code、Codex）通过 `rove api` 在命令行驱动 Rove。",
  optionYes: "安装（推荐）",
  optionNo: "跳过",
  legend: "↑↓ 选择 · enter 确认 · q 跳过设置",
  keysTitle: "键盘基础",
  keysBare: "裸键作用于当前聚焦面板 — {nav} 移动，{open} 打开。",
  keysOnePress: "少量单次快捷键属于 Rove 自己 — {newTab} 新标签页，{focusNext} 切换面板。",
  keysPrefix: "{prefix} 打开命令层 — 按住稍等会出现命令指南。",
  keysHelp: "随时按 {help} 查看完整的实时键位表。",
  keysLegend: "enter 完成",
  appliedCompletions: "✓ 补全已写入 {path}（新开的 shell 生效）",
  skippedCompletions: "· 已跳过补全 — 之后可随时运行 `{command}`",
  installingSkill: "正在安装 Rove agent skill（{command}）…",
  skillFailed: "! skill 安装失败 — 可用 `{command}` 重试",
  skippedSkill: "· 已跳过 agent skill — 之后可随时运行 `{command}`",
  ready: "一切就绪！",
  readyHint: "运行 `rove` 启动 TUI。",
}
