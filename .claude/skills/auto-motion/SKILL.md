---
name: auto-motion
description: 在 kobe 仓库内跑 auto-motion——把 transcription.srt 拆成多段 MG 动画镜头并拼接成竖屏视频(storyboard 分镜 + theme.md 全片主题 + 逐镜头 claude -p 子进程 + ffmpeg 拼接)。本 skill 是薄 wrapper:解析 auto-motion 模板根,继承 kobe 品牌 theme,执行逻辑以 auto-motion 仓库的 canonical SKILL.md 为准。当用户说"跑 auto-motion"、"把这个字幕稿/口播稿做成视频"、"给 kobe 做一条 MG 宣传片"时使用。
---

# auto-motion(kobe wrapper)

canonical 执行逻辑在 auto-motion 仓库的 `.claude/skills/auto-motion/SKILL.md`——本文件不复制那份流程(避免漂移),只做两件事:定位模板根、注入 kobe 的上层 theme。

## Step A — 解析模板根(AUTO_MOTION_ROOT)

按顺序取第一个命中的:

1. `../auto-motion`(workspace sibling,`/Users/jacksonc/i/auto-motion`)——优先,含最新的 theme/引擎改动。
2. `refs/auto-motion` —— 已存在则用。
3. 都没有:`git clone --depth 1 https://github.com/vibe-motion/auto-motion.git refs/auto-motion`(refs/ 已 gitignore,40M 模板不进 kobe 仓库)。

然后**通读 `<AUTO_MOTION_ROOT>/.claude/skills/auto-motion/SKILL.md` 并按它执行**(storyboard → theme.md → 镜头目录 → 顺序执行监控 → 拼接交付)。单镜头模板是 `<AUTO_MOTION_ROOT>/exampleFolder/run-claude-ai.sh`,scene skills 从 `<AUTO_MOTION_ROOT>/exampleFolder/.claude` 复制。

## Step B — kobe 的上层 theme(canonical SKILL 里 Step 0.5 优先级 ② 的具体来源)

在 kobe 仓库里跑时,派生 `theme.md` 前先感知这些品牌源,继承而不是重新发明:

- **品牌视觉/配色/字体**:`packages/branding`(Remotion 品牌管线,landing 片的既有视觉语言)。
- **logo 资产**:`docs/assets/brand/logos/`。
- **产品气质**:TUI 默认主题是 `claude`(`DEFAULT_THEME`,品牌身份,见 CLAUDE.md)——终端质感、暗底、Claude 橙系强调是默认调性。
- 用户在对话里给的视觉要求仍然是最高优先级(canonical 优先级 ①)。

## 工作目录

不要把 scenes/、final.mp4 写进 kobe 源码树。在 scratchpad 或用户指定目录建运行工作区,只把 `transcription.srt`、storyboard、theme 和产物放那里;需要留档的成片再按用户指示移动。
