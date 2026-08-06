# Handoff — brand-studio × brand-video 生产线落地 + kobe-intro 语音迭代 (2026-07-03)

> 上一份(#192 键盘修复)已归档:[`docs/HANDOFF-v1.md`](./docs/HANDOFF-v1.md)(本地未跟踪)。

## Read first

1. [`docs/design/brand-studio.md`](./docs/design/brand-studio.md) — 架构与生命周期(Mermaid),本轮的顶层设计。
2. [`.claude/skills/brand-video/SKILL.md`](./.claude/skills/brand-video/SKILL.md) — 通用 video producer;**开头「设计原则」三条是 Jackson 定的不可漂移边界**。(实体是独立仓库 **Sma1lboy/brand-video**,以嵌套 submodule 挂在 brand-studio 仓库 `producers/brand-video-video`,kobe 侧是 symlink;`git clone --recursive` 逐级拉全)
3. [`.claude/skills/brand-video/references/replay-capture.md`](./.claude/skills/brand-video/references/replay-capture.md) — 原 remotion-ref-replay 全文(分析+捕获+相机权重)。
4. [`marketing.studio.yaml`](./marketing.studio.yaml) — studio 绑定表(scratch/approved/producer)。
5. [`public/assets/accepted.yaml`](./public/assets/accepted.yaml) — 资产台账(revision 5)。
6. `kobe api issue-list --repo /Users/jacksonc/i/kobe` — issue #3–#6 是本线待办。

## Goal

把品牌资产生产线立起来:brand-studio 上层策展(scratch→accept→settle 目录契约),brand-video
作为唯一通用 video producer(分析层为核心资产),并用 kobe-intro 宣传片把"口播 TTS/自声克隆"
半边从文档变成实证。

## Current state

- 本线全部提交已在 `origin/main`(被并行会话 pull --rebase 重写过 SHA,tip = `798ed28e`;
  线内容:`a91c1198`→`798ed28e` 共 14 个 brand 提交)。
- **注意:这个 checkout 是多 agent 共享的**,分支/HEAD 会被并行会话切换(handoff 时在
  `fix/memory-sse-issue-snapshots`)。动 git 前先看 `git branch --show-current`。
- settle 状态(`543ea9a1`,已 push):台账 revision 5 —— **canonical `kobe-intro.mp4` = 34s 无声版**
  (声音未定期间的发布基线);ElevenLabs 版挂起为 `kobe-intro-v2-elevenlabs.mp4`。
  **v3–v5.1 四个语音候选未 settle**,在 `.studio/out/kobe-intro/out/`(gitignored):
  `-edge-yunxi`(46.1s) / `-f5-clone`(41.0s) / `-self-voice`(39.3s) / `-self-v51`(40.1s,三段协议)。
- 声纹资产(本地,不入库):`~/voice-ref-master.wav`(28.6s 母带)+ `voice-ref-{zh,en,mix}.wav` 切段;
  ElevenLabs CLI 已登录(`~/.elevenlabs/api_key`,free 计划);scratchpad `cosy-env`(f5-tts+whisper)、
  `mlx-env`(mlx-audio)是临时 venv,session 目录回收即失效。
- auto-motion fork:`Sma1lboy/auto-motion@1364d0c`(theme/引擎改动);kobe wrapper 指向它。
- 架构图 Artifact:https://claude.ai/code/artifact/b448cefc-72ed-4a21-84f0-ea026101afa1
- 会话前遗留脏文件仍未动:`.github/workflows/*` 两个、`AGENTS.md`、`PONYTAIL-AUDIT.md`、`TUI-LOGIC-BUGS.md`。

## What just shipped(时序)

1. auto-motion:theme 感知 + 引擎可插拔(fork 承载);kobe wrapper skill。
2. brand-video skill v1(packages/branding 内)→ 按 Jackson 要求改独立项目 → 最终落 `.studio/out/<name>/`。
3. 全套视频 subskill vendor 进 `.claude/skills/`(hyperframes×3、remotion-best-practices 等,~40M)。
4. **目录契约统一**(`fea49b71`):`.studio/`(gitignored scratch)→ accept → `public/assets/` + 台账;
   marketing-harness symlink 正名 brand-studio;submodule 段名修复;kobe-intro v1 settle。
5. **ref-replay 并入 brand-video**(`85b94766`):三条设计原则(通用独立/分析层最重/单一 skill);
   旧名留别名;能力插槽 bgm/TTS/facecam。
6. kobe-intro v2(ElevenLabs)settle(`3b6cb032`):TTS 实测 50.4s vs SRT 预估 34s——manifest 反推
   时间轴的核心主张被实证。
7. 语音三引擎 + 两轨原则 + 自声协议(`5132d2b4`/`829b8de2`/`e3cd06ae`/`798ed28e`):
   edge-tts 免费路线、voice/caption 分离(命令不进嘴)、AskUserQuestion 选声音、
   参考母带 20–30s 三段协议(纯中/纯外/混合,whisper 定界)。

## What worked

- **一致性靠 import 不靠 prompt**:镜头组件只从 theme.ts 取色,grep hex 做 review 门。
- manifest(实测时长)反推镜头边界 + 累计取整;静音/有声同工程双形态。
- F5-TTS 零样本克隆(pip 官方包,单句 ~22s @ Mac):example voice→自声版全链路通。
- whisper 词级时间戳切参考母带(silencedetect 被句内停顿骗过,实测)。
- `.studio/out/<name>/` 每片一个独立 Remotion 项目;quicklook `startAt` prop 复用真机捕获。

## What didn't work(别再试)

- PyPI `cosyvoice` 包 = 野包(装的是 v1-300M、默认 cuda、缺依赖链)。
- Python 版 mlx-audio 没有 CosyVoice 后端(支持在 mlx-swift-audio);官方 CosyVoice2 仓库
  macOS 要编 pynini/openfst,判死,备选走 Docker/Linux(issue #5)。
- ElevenLabs free 计划:library 音色 402(paid_plan_required),只能 premade(中文带口音)。
- Pixabay 拦服务端抓取(403);FreePD 已关站——CC 音乐直链用 Incompetech。
- 短参考(英文样本少)克隆声念英文发飘 → 三段母带协议的由来。

## Next steps(优先级序)

> **声音部分已交接给另一位接手人**——下面 1/2/4 属于接手人的范围,本线不再推进。

1. **issue #3**:试听四候选拍板 → settle 替换台账 v2(revision 5,ElevenLabs 版归档,
   老条目标 superseded 不删)。settle 模式照 `fea49b71`/`3b6cb032` 两个提交。
2. **issue #4**:`--engine f5` 正式化进 `generate-voiceover.ts`(venv/模型/--ref_audio 参数化,
   进 skill 脚手架;当前是 scratchpad 一次性 bash 循环)。
3. **issue #6**:facecam PiP 插槽实测(配方在 SKILL.md,未实跑)。
4. **issue #5**(非阻塞):CosyVoice2 Docker 路线或 mlx-audio 其他中文克隆后端(voxcpm/spark/indextts)。
5. 可选:settle 版挂 landing(packages/kobe-landing/assets 消费 public/assets)。

## Open questions

- 四个语音候选选哪个 settle?(唯一阻塞项,等 Jackson 的耳朵)
- 要不要付费 ElevenLabs 解锁中文 library 音色作为高质量路线?
- bgm《Floating Cities》是 CC-BY:发布渠道的 credit 文案放哪(landing 页脚/视频简介)?

---

# Handoff — jackosn.chen/huge-arch 架构夜班 (2026-07-10 03:15–10:30)

Jackson 指定的通宵 /loop:工程层面模块化拆分,**所有源码文件 ≤500 行**,零行为变化。
分支 `jackosn.chen/huge-arch`(worktree `.claude/worktrees/jackosn.chen+huge-arch`),
基于 0.7.92,**12 个 refactor 提交,未推送、未合并 —— 是否并回 main 等 Jackson 拍板**。

## 结果

- kobe / kobe-daemon / kobe-web 三包全部文件 ≤500 行(此前 12 个超标,最大 933)。
- 每刀都过:kobe 全量测试(2500+)、root lint、typecheck、kobe-web vitest 72/72 + vite build。
- 拆分模式:公共入口 + 内部分层(tmux/client、session-layout、daemon/protocol 用 barrel 保住
  几十个 import 点);纯策略/效果分离(layout-plan、pane-heal-plan);React 页面按 区域/行渲染/
  副作用 hook 拆(AppShell→TaskRail、Board→BoardColumns+useIssueActions、SettingsPage、ChatTranscript)。
- 顺手修复:worktree manager 与 paths.ts 的重复 canonicalize;三个同名 parsePorcelain 歧义
  (worktree-list 的更名 parseWorktreeListPorcelain);kobe-web vitest 误收 playwright e2e spec
  (存量红,已在 vite.config.ts 排除 e2e/**,72/72 变绿)。

## 风险 / 注意

- 全部是搬移+改 import,唯一语义敏感点:daemon close() 的 collector teardown 顺序保持原样
  (collectors.ts 尾注),engineTabExit 的 chattab 动态 import 保留(避免静态图变重)。
- kobe-web 无 tsc 门(tsconfig 跨包别名存量问题),该包只有 vitest+biome+vite build 三道门。
- 合并建议:squash 会复活 changeset 的坑不适用(本分支无 changeset);历史保留合并走本地
  `git merge --no-ff`(GitHub 按钮 squash-only)。

---

# Handoff — jackosn.chen/huge-arch-v2 日班 pure-TUI 收拢 (2026-07-10 10:45–16:45)

夜班(huge-arch,已合入 main)的续集:30 分钟/轮 /loop,只动 pure TUI
(tui-react + 嵌入终端栈),tmux 栈不迭代。分支
`jackosn.chen/huge-arch-v2`(worktree `.claude/worktrees/jackosn.chen+huge-arch-v2`),
**8 个提交 + 2 次 merge main(0.7.92→0.7.93),未推送、未合并,等 Jackson 拍板。**

## 结果(全部零行为变化)

- 去重:两个 task-action host 的 dialog 适配器(task-dialog-adapters.ts);
  51 处 errorMessage 内联(lib/error-message.ts);32 处 latest-ref 惯用法
  (tui-react/lib/use-latest.ts,biome.json 声明 stableResult、规则仍 error 级);
  sidebar 行卡片四组克隆(useRowCardChrome + RowLine);SidebarProps↔BindingsOpts
  九个回调(SidebarTaskCallbacks);new-task/quick-task 的 best-effort 连接样板
  (connectOrchestratorBestEffort)。
- 拆分:TerminalTabs 490→431(use-tab-handoffs);workspace/host 462→351
  (use-workspace-selection + show-workspace)。
- 文档:panes/terminal/CLAUDE.md 嵌入终端半边按现状重写(原文停在 React 迁移前)。
- 工具:jscpd 克隆扫描跑过一轮(pure-TUI 簇 25 组,可行目标已清空)。

## 有意不做(记录了理由)

- pty-mock ↔ pty-pipe/pty-xterm-base 69 行订阅管理重复:测试替身独立性,故意保留。
- Sidebar 10Hz spinner 全量重渲:文件头明示的已接受取舍,未推翻。
- 两个 host 的选择/焦点状态合并:#303 刚统一过语义,风险大于收益。

## 注意

- biome.json 动过一处(useLatest stableResult)—— 已在会话里向 Jackson 明示。
- merge 0.7.93 时 use-accessor.ts 冲突:main #306 整个重写为 ReadableState/
  useSyncExternalStore,取了 main 版(方向一致,#306 就是接口泛化)。
- kobe-web 未动(v1 已清完,本阶段 focus pure TUI)。
