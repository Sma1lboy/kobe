---
name: brand-video
description: brand-studio 绑定的通用 video producer(skills.video)——把口播稿/字幕稿(transcription.srt)、参考录屏或 brief 做成品牌视频。核心能力是分析层:脚本/参考视频 → storyboard + 权重分配(时间预算、镜头类型、相机 region);生产层是每支视频一个 .studio/out/<name>/ 独立 Remotion 项目,镜头组件共享从宿主 metadata 注入的品牌 theme;真机演示走内置 replay-capture 模块;支持 bgm/TTS 口播/人脸角标 PiP。用户 accept 后按 brand-studio settle 流程落入 public/assets/。当用户说"做一条宣传片"、"把口播稿/参考视频做成视频"、"做 promo/brand video"时使用。
---

# brand-video(brand-studio 的通用 video producer)

## 设计原则(Jackson 定的边界,迭代本 skill 时不可漂移)

1. **通用、独立**:本 skill 永远不 for 单一产品;宿主上下文只从 metadata 注入(无宿主则问),
   目标形态是独立仓库 + submodule 挂载。
2. **分析层是最重的权重**:脚本/参考视频的理解(storyboard + 时间预算 + 相机权重分配)是
   核心资产;生产层和插槽都排在它后面,迭代投入按此分配。
3. **只此一个 video skill**:不许再分裂出平行的视频 skill(ref-replay 已并入,旧名只是别名);
   新能力(音乐 / TTS 口播 / 人脸角标 PiP 等)作为插槽长在同一时间轴上,不另立门户。

**不 for 任何单一产品。** 有宿主 repo 时,上下文来自其 brand-studio metadata
(`marketing.studio.yaml`):theme 源看 `theme.references`(kobe = `packages/branding`),
scratch/approved 目录看 `artifacts.*`。换一个产品 repo,换的是 metadata,不是本 skill。
**没有宿主时(找不到 marketing.studio.yaml / theme 源)不要假设、不要硬造品牌**:开工前
提一嘴问清两件事——①品牌方向(配色/字体/气质,或给参考图)②产物放哪;拿到答案把 theme
写成项目内 `src/theme.ts`,目录就用用户指定的工作区,流程其余部分不变。
本 skill 可整体抽成独立 GitHub 仓库、以 submodule 挂载(同 brand-studio 本体)——
不变量:`git clone --recursive` 一次拉全。

**在 brand-studio 体系里的位置**:`skills.video` 绑定的 producer——只生产,不落账:
- **生产(scratch)**:统一 temp `.studio/out/` 下,**每支视频/每类适配一个独立项目**
  `.studio/out/<name>/`(自带 package.json 与项目管理,gitignored)。
- **验收(settle)**:用户 accept 后,成片拷到 `public/assets/video/<name>.mp4`,在
  `public/assets/accepted.yaml` 追加条目(modality: video,带 source/checksum/尺寸/时长),
  bump revision。没 accept 的产物永远留在 scratch。

## 能力权重(迭代本 skill 时按这个优先级)

1. **分析层(核心资产)** —— 把输入变成带权重的 storyboard:时间预算怎么切、每拍是什么
   镜头类型、相机看哪个 region。视频的成败在这一层就定了;生产层只是执行。
2. **生产层** —— per-project Remotion 工程,一致性由构造保证。
3. **能力插槽** —— bgm / TTS 口播 / 人脸角标,按需挂在同一时间轴上。

## Step 0 — 分析层:输入 → storyboard(最高杠杆)

三种输入,同一产出 `.studio/out/<name>/storyboard.md`:

| 镜头 | 起止 (s) | 时长 (s) | voice(口播词) | caption/画面文本 | 视觉概念(具体到能直接写组件) | 类型 (mg / replay) |
|---|---|---|---|---|---|---|

**voice 和 caption 是两套内容,分析层必须分开写**:URL、shell 命令、包名、代码、版本号等
技术字符串只进 caption/画面(终端卡、字幕条),**voice 一律说人话**——"npm install -g @scope/pkg"
的口播词是"一行命令,装好 kobe",让 TTS 念命令是硬伤。两列内容一致的镜头直接复用,不一致
的镜头以 voice 定时长、caption 跟画面。

- **口播稿/SRT**:时长毫秒精度,镜头首尾相接覆盖全稿,**Σ 时长 = 末条结束 − 首条开始,
  误差 ≤ 0.1s**;字幕间空白并入前一镜头。
- **参考录屏**:按 [references/replay-capture.md](references/replay-capture.md) 的纪律逐帧
  理解(1 帧/秒抽样),storyboard 行要具体到"user action 可逐字敲进捕获脚本、region 可直接
  写成矩形"。**相机权重分配是这一层的核心**:每个 stage 看哪个 region、binary change-mask
  怎么选主体、band/quantile 怎么框——算法和踩坑全在那份 reference 里。
- **brief**:先补齐受众/时长/落位,再拆表;视觉概念写不具体 = 没拆完,回去重写。

## Step 1 — 生产层:镜头组件 + 单一 composition

```text
.studio/out/<name>/
  package.json         ← 独立项目;remotion + @remotion/google-fonts(版本对齐宿主既有工程)
  .gitignore           ← node_modules/ out/
  storyboard.md
  src/
    index.ts / Root.tsx
    theme.ts           ← 从宿主 theme 源物化拷入(metadata theme.references 指到的 token 文件)
    ui.tsx             ← SceneShell(字幕条)、Wordmark 等共享件
    Scene01Hook.tsx    ← 每镜头一个组件,import { colors, monoStack } from "./theme"
    <Video>.tsx        ← <Series> 串接所有镜头 + 音轨
    replay/            ← 有真机镜头才有:replay 渲染器 + frames.json 拷贝
```

- **镜头组件只准从 theme.ts 取色,不准字面 hex**(review 时 grep `#[0-9a-fA-F]{6}`)——
  品牌一致性由构造保证,不靠 prompt 约束。
- **帧数从 SRT 累计时间点取整**:`start = Math.round(startSec * fps)`,时长 = 相邻差;
  逐镜头取整再求和会累计漂移,禁止。
- 动效用 Remotion 原生 `interpolate`/`spring`;hyperframes/GSAP 产物先渲 mp4 再
  `<OffthreadVideo>` 嵌入,不混两套时间轴。
- 领域知识按需加载(宿主 `.claude/skills/` 已 vendor):remotion-best-practices(必载)、
  hyperframes 系(走 clip 嵌入时)、motion-graphics / general-video / image-gen。

## Step 2 — replay 镜头(真机演示)

方法全在 [references/replay-capture.md](references/replay-capture.md):隔离环境跑真 app、
`capture-<name>.ts` 产出 frames.json、舞台相机(STAGES + frameStage 权重算法)、speed cut
双时钟、交付压缩与全套排错表。UI 迭代后重跑 capture 即可,视频自动跟上。
捕获对象不限 TUI——任何可脚本化+截屏的 app 都行,只换"capture 原语"。

## Step 3 — 能力插槽(同一时间轴,按需挂载)

- **bgm**:`<Audio src={staticFile("bgm.mp3")} volume={0.15} loop />` 作第二音轨;
  有口播时 bgm 压到 0.1–0.2,收尾随片尾 `interpolate` 淡出。
- **TTS 口播**:到口播这步**必须用 AskUserQuestion 问声音路线**——声音是用户的身份,不替用户拍板。
  选项(默认推荐第一个):
  1. **默认音色(Recommended)**:edge-tts `zh-CN-YunxiNeural`(免费无 key,原生中文;晓晓/云扬可换)。
  2. **用自己的声音**:F5-TTS 零样本克隆(`pip install f5-tts`,本地跑)。**参考母带协议**:
     - 母带 20–30s(`ffmpeg -f avfoundation -i ":0" -t 32 -ar 24000 -ac 1 -y ~/voice-ref-master.wav`),
       文案内容与产品无关(通用声纹,一次录制处处复用),照念、段间明确停 1 秒。
     - **口播含外语(如中英混)→ 母带录三段**:纯中文 / 纯外语 / 中外混合;**口播只有英语 →
       一段纯英语即可**。单段 ref ≤15s(F5 上限)。
     - 切段用 whisper 词级时间戳定界(silencedetect 会被句内停顿骗),切成 ref-zh / ref-en /
       ref-mix 三个 wav;**合成时按目标句的语言构成挑 ref**——英文重的句子用 ref-en,混合句用
       ref-mix。参考里外语样本不足 = 克隆声念外语发飘,这就是三段协议存在的原因。
     - ref_text 必须与该段实际朗读一字不差(用原始文案,别用 whisper 的转写——base 模型转写有错)。
  3. ElevenLabs(有 key 且要更高质量;免费计划只能用 premade,中文有口音)。
  4. 无口播(纯字幕 + bgm)。
  逐镜头生成后 ffprobe 量实际时长写进 `src/audio-manifest.json`;
  composition 从 manifest 反推镜头边界(时长 = 实测 + 呼吸垫,且不低于该镜头最晚内部动效的
  下限),累计取整防漂移。manifest 为 null 时回落 SRT 静音版——同一工程双形态,不分叉项目。
- **人脸角标(facecam PiP)**:录好的人脸片段用 `<OffthreadVideo>` 挂右下角固定 slot
  (圆角矩形 + theme 边框,宽 ≈ 22% 画幅,`muted`——声音走口播轨),整段常驻或按镜头显隐;
  它是时间轴上的一个 layer,不改任何镜头组件。

## Step 4 — 预览、渲染、验收

```bash
cd .studio/out/<name>
bun run studio        # 热重载调镜头/相机,秒级迭代
bun run render        # -> out/<name>.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 out/<name>.mp4
```

- 时长 ≈ storyboard 总跨度(±0.1s);逐镜头抽帧检查品牌色(`remotion still --frame=N`)。
- 落位走 brand-studio settle(见文件头):accept → `public/assets/` + 台账;不 accept 留 scratch。

## 常见坑

| 症状 | 原因 | 修法 |
|---|---|---|
| 镜头间配色漂移 | 组件里写了字面 hex | 只从 theme.ts import;review 时 grep hex |
| 音画错位越到后面越大 | 逐镜头取整帧数再求和 | 帧数从累计时间点取整,时长=相邻差 |
| TTS 对不上字幕 | 拿预估时长硬套 SRT | 以 TTS 实际时长反推镜头边界(kobe-intro 实测:预估 34s,实说 50.4s) |
| ElevenLabs 402 paid_plan_required | 免费计划不能用 library voice | 先 GET /v1/voices,选 category=premade 的音色 |
| 字体闪换/缺字 | 系统字体不确定 | `@remotion/google-fonts` 显式加载 |
| replay 镜头过期 | UI 改了没重跑 capture | 重跑 capture 再 render,别手改 frames.json |
| 相机框错主体/抖动 | region/权重没调对 | 按 replay-capture.md 的 tuning knobs 顺序调 |
| 渲染时长对不上 | durationInFrames 拍脑袋 | 从 storyboard 总跨度(或 frames.json 末帧)推导 |

worked example:`.studio/out/kobe-intro/`(宿主 kobe,scratch 本地)→
`public/assets/video/kobe-intro.mp4`(已 settle,台账 `public/assets/accepted.yaml`)。
