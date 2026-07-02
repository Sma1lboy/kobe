---
name: brand-video
description: kobe 原生宣传片管线——把口播稿/字幕稿(transcription.srt)做成品牌宣传视频,在 packages/branding 的单一 Remotion 工程内完成:镜头 = 共享品牌 token 的 React 组件(Series 串接),真机演示镜头走 remotion-ref-replay 捕获,一条 remotion render 出片。取代 auto-motion 的"每镜头一个 claude -p 子进程 + prompt 传品牌约束 + ffmpeg 拼接"模式。当用户说"做一条 kobe 宣传片"、"把口播稿做成视频"、"做 promo/brand video"、"给这段字幕配 MG 动画"时使用。
---

# brand-video(kobe 原生宣传片管线)

auto-motion 的教训:每镜头起独立子进程、从零搭工程、品牌色靠 prompt 文字约束——慢(小时级)、必然漂移、必然返工。
本管线反其道:**一个 Remotion 工程,镜头是组件,theme 是 import,一致性由构造保证而不是 prompt 求来**。

先加载这两个 skill(缺一不可):
- **remotion-best-practices** — Remotion 动画/组合/字体/ffmpeg 领域知识。
- **remotion-ref-replay**(本仓库)— 真机演示镜头的捕获管线(frames.json + 舞台相机)。

工程就是 `packages/branding`(依赖已装,`bun run studio` 可预览)。品牌 token 在
[`src/colors.ts`](../../../packages/branding/src/colors.ts):暖黑底 `bg`、陶土橙强调 `blue`、
`monoStack` 等宽字体——**镜头组件只准从这里取色,不准出现字面 hex**。这一条就是对
auto-motion "青绿 hacker 风清零"式返工的结构性根治。

## Step 0 — storyboard(和 ref-replay 同一纪律,最高杠杆)

输入:口播稿或 `transcription.srt`(可选配好的 `voiceover.mp3`)。
通读后写 `src/<video>/storyboard.md`:

| 镜头 | 起止 (s) | 时长 (s) | 口播文案 | 视觉概念(具体到能直接写组件) | 类型 (mg / replay) |
|---|---|---|---|---|---|

- 时长毫秒精度;所有镜头首尾相接覆盖全稿,**Σ 时长 = 末条结束 − 首条开始,误差 ≤ 0.1s**。
- `replay` 类型 = 真实 kobe TUI 演示片段(装 app、开任务、并行会话之类),走 ref-replay 捕获;
  `mg` 类型 = 纯 MG 动画(标题、数据、概念图),纯 Remotion 组件。
- 视觉概念写不具体 = 没拆完,回去重写。

## Step 1 — 镜头组件 + 单一 composition

```text
src/<video>/
  storyboard.md
  Scene01Hook.tsx      ← 每镜头一个组件,import { colors, monoStack } from "../colors"
  Scene02Problem.tsx
  ...
  <Video>.tsx          ← <Series> 串接所有镜头 + <Audio> 口播轨
```

- 主组件用 `<Series>`,每个 `<Series.Sequence durationInFrames={…}>` 一个镜头。
- **帧数从 SRT 的累计时间点取整**:`start = Math.round(startSec * fps)`,时长 = 相邻 start 之差。
  逐镜头独立取整再求和会累计漂移,禁止。
- 动效用 Remotion 原生 `interpolate` / `spring`(帧驱动,天然确定性)。不需要 GSAP——
  Remotion 里帧就是真相;确需 hyperframes/GSAP 产物时,先渲成 mp4 再 `<OffthreadVideo>` 嵌入,不混跑两套时间轴。
- 口播:`<Audio src={staticFile("voiceover.mp3")} />`;没有音频就纯字幕/无声,结构不变。
- 在 `src/Root.tsx` 注册 composition;竖屏口播默认 1080x1920@30fps,横屏 demo 1280x720。
  `durationInFrames` 从 storyboard 总跨度算,不要拍脑袋。

## Step 2 — replay 镜头(真机演示,auto-motion 做不到的部分)

按 remotion-ref-replay 的方法:隔离 tmux socket + 一次性 HOME 跑真 kobe,
`scripts/capture-<video>.ts` 产出 `frames.json`,镜头组件套用
`src/quicklook/QuickLookReplay.tsx` 的渲染器 + 舞台相机(worked example,直接抄结构)。
UI 迭代后重跑 capture 即可,视频自动跟上。

## Step 3 — 预览、渲染、验收

```bash
cd packages/branding
bun run studio                                      # 热重载调镜头/相机,秒级迭代
bun x remotion render src/index.ts <video> out/<video>.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 out/<video>.mp4
```

- 时长 ≈ storyboard 总跨度(±0.1s);逐镜头抽帧检查品牌色(`remotion still --frame=N`)。
- 一条命令一个 mp4,没有 per-scene 拼接,不存在规格归一问题。
- 产物按用途落位:landing 用的进部署流程,留档的进 `docs/assets/brand/`(见 package.json 现有脚本的约定)。

## 常见坑

| 症状 | 原因 | 修法 |
|---|---|---|
| 镜头间配色漂移 | 组件里写了字面 hex | 只从 `colors.ts` import;review 时 grep `#[0-9a-fA-F]{6}` |
| 音画错位越到后面越大 | 逐镜头取整帧数再求和 | 帧数从累计时间点取整,时长=相邻差 |
| 字体闪换/缺字 | 系统字体不确定 | `@remotion/google-fonts` 显式加载,栈用 `monoStack` |
| replay 镜头过期 | UI 改了没重跑 capture | 重跑 `scripts/capture-<video>.ts` 再 render,别手改 frames.json |
| 渲染时长对不上 | durationInFrames 拍脑袋 | 从 storyboard 总跨度(或 frames.json 末帧)推导 |
