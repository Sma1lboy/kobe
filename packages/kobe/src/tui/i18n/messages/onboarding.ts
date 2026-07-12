/**
 * `onboarding.*` messages — the first-run wizard (`src/cli/onboarding.ts` +
 * `src/tui-react/onboarding/host.tsx`). English is the source of truth;
 * `zh: typeof en` keeps the shapes locked together.
 */

export const en = {
  /** Wizard header */
  title: "Welcome to kobe",
  /** One-liner under the header */
  subtitle: "Two quick questions before your first launch.",
  /** Step 1 question; {shell} is the detected shell name (zsh/bash/fish) */
  completionsQuestion: "Install shell completions for {shell}?",
  /** Step 1 explanation */
  completionsExplain: "Tab-completes kobe subcommands. One line is added to your shell config.",
  /** Step 2 question */
  skillQuestion: "Install the kobe agent skill?",
  /** Step 2 explanation */
  skillExplain: "Teaches coding agents (Claude Code, Codex) to drive kobe from the shell via `kobe api`.",
  /** Recommended option */
  optionYes: "Yes (recommended)",
  /** Decline option */
  optionNo: "No",
  /** Key legend at the bottom of the wizard */
  legend: "↑↓ select · enter confirm · q skip setup",
  /** Post-wizard: completions line was written; {path} is the rc/completions file */
  appliedCompletions: "✓ completions hooked into {path} (takes effect in new shells)",
  /** Post-wizard: completions declined; {command} re-runs it later */
  skippedCompletions: "· completions skipped — run `{command}` anytime",
  /** Post-wizard: about to run the skill installer; {command} is the npx command */
  installingSkill: "installing the kobe agent skill ({command})…",
  /** Post-wizard: skill installer failed; {command} retries it */
  skillFailed: "! skill install failed — retry with `{command}`",
  /** Post-wizard: skill declined; {command} re-runs it later */
  skippedSkill: "· agent skill skipped — run `{command}` anytime",
  /** Final ready banner */
  ready: "You're ready to go!",
  /** Final hint: how to start */
  readyHint: "Run `kobe` to launch the TUI.",
}

export const zh: typeof en = {
  title: "欢迎使用 kobe",
  subtitle: "首次启动前，先回答两个小问题。",
  completionsQuestion: "为 {shell} 安装 shell 补全吗？",
  completionsExplain: "让 kobe 子命令支持 Tab 补全，会在你的 shell 配置里加一行。",
  skillQuestion: "安装 kobe agent skill 吗？",
  skillExplain: "教会编码 agent（Claude Code、Codex）通过 `kobe api` 在命令行驱动 kobe。",
  optionYes: "安装（推荐）",
  optionNo: "跳过",
  legend: "↑↓ 选择 · enter 确认 · q 跳过设置",
  appliedCompletions: "✓ 补全已写入 {path}（新开的 shell 生效）",
  skippedCompletions: "· 已跳过补全 — 之后可随时运行 `{command}`",
  installingSkill: "正在安装 kobe agent skill（{command}）…",
  skillFailed: "! skill 安装失败 — 可用 `{command}` 重试",
  skippedSkill: "· 已跳过 agent skill — 之后可随时运行 `{command}`",
  ready: "一切就绪！",
  readyHint: "运行 `kobe` 启动 TUI。",
}
