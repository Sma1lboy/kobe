# brand-studio × brand-video — 架构与生产生命周期

brand-studio 是**策展层**(curate/settle,永不生产);brand-video 是它在 `marketing.studio.yaml`
里 `skills.video` 绑定的 **video producer**(只生产,不落账)。目录契约:生产在 `.studio/out/`
(gitignored scratch),用户 accept 后 settle 进 `public/assets/` 并记入 `accepted.yaml`。

## 架构:谁管谁

```mermaid
flowchart TB
  user["用户(人工闸门)<br/>审批生产 · review · accept"]

  subgraph studio["brand-studio — 策展层(只管不产)"]
    stages["stage 路由:gen-repo / settle-repo / retire-repo"]
    ledger["台账:public/assets/accepted.yaml<br/>(modality · source · checksum · revision)"]
  end

  meta["marketing.studio.yaml(绑定表)<br/>skills.video → brand-video · skills.image → gpt-image<br/>scratch=.studio/out · approved=public/assets"]

  subgraph producers["producer 层 — 只生产"]
    bv["brand-video(video)<br/>Remotion 工程 · 每支片子一个独立项目<br/>.studio/out/&lt;name&gt;/"]
    gi["gpt-image(image)"]
  end

  subgraph subskills["brand-video 按需加载的 subskill(全部 vendor 在 .claude/skills/)"]
    rbp["remotion-best-practices"]
    rrr["remotion-ref-replay<br/>(真机 TUI 捕获)"]
    hf["hyperframes ×3<br/>(GSAP/blueprints/transitions)"]
    misc["motion-graphics · general-video · image-gen"]
  end

  branding["packages/branding — 品牌资产库<br/>colors.ts(theme 源) · quicklook capture(frames.json)"]

  user --> studio
  studio --> meta
  meta -->|"video 能力"| bv
  meta -->|"image 能力"| gi
  bv --> rbp & rrr & hf & misc
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
