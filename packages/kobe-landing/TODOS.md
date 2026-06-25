# kobe-landing — TODOs

Landing page 迭代清单。目标：去掉与项目实际不符的细节，让首屏更吸引人、更可信。

源文件：`packages/kobe-landing/index.html`（单文件静态页）。

**状态：全部完成** ✅
- #1 #2 #4 → 已并入 PR #167
- #3 (GitHub logo + 实时 star) → 已并入 PR #167
- badge 整段删除 → PR #168
- #5 (多阶段动画 mockup)、#6 (CSS 插图 + 滚动揭示)、#7 (可视化 fan-out) → 第 3 批分支 `kobe/landing-batch3`

---

## 1. Hero badge 去重
- 位置：`index.html` 顶部 hero badge（L52）"TUI orchestrator for Claude Code · bun i -g @sma1lboy/kobe"
- 问题：`bun i -g @sma1lboy/kobe` 与下方的安装命令按钮（L64 `bun install -g @sma1lboy/kobe`）重复。
- 改法：badge 只保留 slogan（如 "TUI orchestrator for Claude Code"），删掉安装命令片段。

## 2. 安装要求补充平台支持
- 位置：L69 "Requires Bun ≥ 1.3.11, tmux, and one engine CLI on your PATH."
- 改法：加上 macOS / Linux 支持说明（如 "Runs on macOS & Linux."）。
- 待确认：Windows 是否支持（WSL?）——确认后再定文案。

## 3. 顶部 GitHub 链接升级
- 位置：nav GitHub 链接（L44）
- 改法：
  - 显示 GitHub 官方 logo（inline SVG）。
  - 显示 repo 当前**实时 star 数**。
- 实现注意：纯静态页，star 数需前端 fetch GitHub API（`https://api.github.com/repos/Sma1lboy/kobe`，读 `stargazers_count`）；注意未鉴权速率限制（60/h per IP），加 fallback/缓存。

## 4. Hero CTA 文案
- 位置：L67 "Read the docs ↗"
- 改法：改成 "Get started"（更有行动号召力）。
- 倾向：采纳。需确认链接目标（docs / 安装段锚点 / README quickstart）。

## 5. TUI mockup 重做
- 位置：workspace section 的窗口 chrome（L80）"ssh devbox — kobe — 178×44" + 整个静态 mockup
- 问题：
  - 标题不符合 kobe 调性。
  - 是个**静态**截图式 mockup，不会动，不够生动。
- 改法：
  - 换更贴合 kobe 的窗口标题。
  - 让 mockup "动起来"（如打字机效果、任务状态流转、live 输出滚动）或换成真实录屏/动图驱动。

## 6. "Why" section 改为图片驱动
- 位置：why section（L162）"// why try it" + "The terminal is the product." + 5 张卡片
- 问题：纯文字卡片，一点都不吸引人。
- 改法：改成**以图片/视觉为驱动**的叙事，引导用户一屏一屏往下滑（scroll-driven 视觉故事），而非一排干巴巴的特性卡。

## 7. "Engines" section 重构 fan-out 呈现
- 位置：engines section（L197）"// choose your engine" + "Bring whatever CLI you already trust." + `kobe api fan-out` 代码块（L211-220）
- 问题：右侧 `kobe api fan-out` 命令显得很怪、让人觉得"不方便"，反而是减分项。
- 改法：换一种更直观、更"轻松好用"的方式展示多引擎/并行能力（弱化裸 CLI 命令，强调一键 fan-out 的体验）。

---

## 已确认的决定
- **#4** "Get started" → 跳 GitHub README（repo quickstart）。
- **#2** 平台文案：macOS & Linux，Windows via WSL。
- **#5 / #6** 暂无现成素材，需新做——先用纯 CSS/HTML 实现动效与图片叙事（不依赖外部录屏）。
