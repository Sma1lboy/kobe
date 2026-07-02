# brand-studio × brand-video — 架构与生产生命周期

brand-studio 是**策展层**(curate/settle,永不生产),在上层管理所有 producer:brand-video
(`skills.video`)、gpt-image(`skills.image`)是它在 `marketing.studio.yaml` 里绑定的生产端
(只生产,不落账)。

**brand-video 是唯一的 video producer,且是通用 skill**(不 for 单一产品;宿主上下文全部由
metadata 注入)。原 remotion-ref-replay 已并入它:参考视频/脚本的**分析层(storyboard +
相机权重分配)是这个 skill 的核心资产**,捕获方法收在其 `references/replay-capture.md`;
旧名保留为兼容别名,只迭代这一个 skill。能力插槽(bgm / TTS 口播 / 人脸角标 PiP)挂在
同一时间轴上,不另立 skill。

目录契约:**所有 producer 的产出先进同一个 temp `.studio/out/`**(gitignored scratch);其中
brand-video 的产出**按 project 分目录**——每支片子/每类适配一个独立 Remotion 项目
(`.studio/out/kobe-intro/` 这类)。用户 accept 后才 settle 进 `public/assets/` 并记入 `accepted.yaml`。

仓库分发:brand-studio 本体是独立 GitHub 仓库,以 submodule 挂在 `.agents/skills/brand-studio`;
producer skill 也可以各开独立仓库、按同样方式挂载——**不变量是 `git clone --recursive` 一次拉全**。

## 架构:谁管谁

```mermaid
flowchart TB
  user["用户(人工闸门)<br/>审批生产 · review · accept"]

  subgraph studio["brand-studio — 策展层(只管不产)"]
    stages["stage 路由:gen-repo / settle-repo / retire-repo"]
    ledger["台账:public/assets/accepted.yaml<br/>(modality · source · checksum · revision)"]
  end

  meta["marketing.studio.yaml(绑定表)<br/>skills.video → brand-video · skills.image → gpt-image<br/>scratch=.studio/out · approved=public/assets"]

  subgraph producers["producer 层 — 只生产(统一 temp:.studio/out/,产出按 project 分目录)"]
    bv["brand-video(video,通用)<br/>① 分析层:脚本/参考视频 → storyboard + 相机权重(核心)<br/>② 生产层:.studio/out/&lt;name&gt;/ 独立 Remotion 项目<br/>③ 插槽:bgm · TTS 口播 · 人脸角标 PiP"]
    gi["gpt-image(image)"]
  end

  subgraph modules["brand-video 的模块与领域知识(vendor 在 .claude/skills/)"]
    rc["references/replay-capture.md<br/>(原 remotion-ref-replay:捕获管线 + 相机权重算法)"]
    rbp["remotion-best-practices<br/>(含 voiceover/TTS 规则)"]
    hf["hyperframes ×3 · motion-graphics 等"]
  end

  branding["宿主 theme 源(metadata theme.references)<br/>kobe = packages/branding:colors.ts · quicklook frames.json"]

  user --> studio
  studio --> meta
  meta -->|"skills.video"| bv
  meta -->|"skills.image"| gi
  bv --> rc & rbp & hf
  branding -->|"colors.ts → src/theme.ts 物化拷入"| bv
  branding -->|"frames.json → src/replay/ 拷入"| bv
```

## 生命周期:一支片子怎么走

```mermaid
flowchart LR
  srt["口播稿<br/>transcription.srt"]
  gen["gen-repo(scratch)<br/>.studio/out/&lt;name&gt;/<br/>storyboard → theme 物化 →<br/>镜头组件 → render"]
  cand["candidate<br/>out/&lt;name&gt;.mp4<br/>(scratch,不入库)"]
  gate{"用户 review"}
  settle["settle-repo<br/>public/assets/video/&lt;name&gt;.mp4<br/>+ accepted.yaml 条目 · revision++"]
  consume["消费方<br/>landing · README · docs"]

  srt --> gen --> cand --> gate
  gate -->|"accept(如:这个无敌了)"| settle --> consume
  gate -->|"改"| gen
  cand -.->|"UI 改版:重跑 capture 再 render"| gen
```

要点:

- **边界**(brand-studio 的 CLAUDE.md):studio 只做确定性的策展动作(路径解析、验证、settle、
  台账、checksum);生产全部在 producer;重工具链 producer(Remotion)不 vendor 进 studio
  payload,走 metadata 绑定——这就是 brand-video 作为"subskill"的形态。
- **一致性由构造保证**:镜头组件只准 `import { colors } from "./theme"`,不准字面 hex;
  theme 是 scaffold 时从 `packages/branding/src/colors.ts` 物化拷入的。
- **scratch 永不自动入库**:没 accept 的产物留在 `.studio/`(gitignored);accept 语义参照
  studio 规则(单候选语境下"这个可以/无敌了"即 accept)。
- worked example:`.studio/out/kobe-intro/`(本机 scratch)→ `public/assets/video/kobe-intro.mp4`
  (已 settle,台账见 `public/assets/accepted.yaml`)。
