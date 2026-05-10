# Academic Paper Style

**Style**: Crisp paper surface, serif title, restrained blue citations, evidence-first hierarchy
**Best for**: Research abstracts, literature reviews, study summaries, medical or academic explanations

## Style Characteristics

| Property | Value |
|---|---|
| Background | Paper white `#fcfcfa` |
| Text | Ink `#202124` |
| Accent | Citation blue `#355c9a` |
| Muted | Scholarly gray `#6a717d` |
| Tint | `rgba(53,92,154,0.05)` |
| Title Font | `Noto Serif SC`, serif — weight 700 |
| Body Font | `Source Serif 4`, `Noto Serif SC`, serif |
| Structure | Journal-like sections with evidence blocks |
| Rules | 2px understated blue dividers |

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; padding: 42px; overflow: hidden; font-family: 'Source Serif 4', 'Noto Serif SC', serif; color: #202124; line-height: 1.72; border: 1px solid rgba(32,33,36,0.08); }
    .card-surface-paper { background: #fcfcfa; }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #6a717d; font-family: 'Inter', 'Noto Sans SC', sans-serif; }
    .card-title { margin: 0 0 16px; font-family: 'Noto Serif SC', serif; font-size: 36px; font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; color: #202124; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.72; color: #40464f; }
    .card-bar { width: 70px; height: 2px; margin: 0 0 22px; background: #355c9a; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.78; color: #202124; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.15fr 0.85fr; }
    .card-panel { padding: 16px 18px; background: rgba(53,92,154,0.05); }
    .card-accent-panel-left { border-left: 2px solid #355c9a; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #355c9a; font-family: 'Inter', 'Noto Sans SC', sans-serif; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.7; color: #40464f; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: rgba(53,92,154,0.08); color: #355c9a; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; font-family: 'Inter', 'Noto Sans SC', sans-serif; }
    .card-stat { font-size: 42px; font-weight: 700; line-height: 1; color: #355c9a; margin: 0; font-family: 'Inter', sans-serif; }
    .card-accent-stat { color: #355c9a; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #6a717d; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; font-family: 'Inter', sans-serif; }
    .card-body.dropcap::first-letter { font: 700 66px/0.84 'Noto Serif SC', serif; float: left; margin: 4px 12px 0 -2px; color: #355c9a; }
    .card-highlight { font-size: 16px; font-weight: 500; line-height: 1.65; color: #202124; padding: 10px 0 10px 16px; margin: 16px 0; }
    .card-accent-highlight-left { border-left: 2px solid #355c9a; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #202124; }
    .card-divider { height: 1px; background: rgba(32,33,36,0.1); margin: 22px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #355c9a; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(32,33,36,0.1); font-size: 11px; color: #6a717d; letter-spacing: 0.04em; font-family: 'Inter', sans-serif; }
  </style>
  <div class="card card-surface-paper">
    <p class="card-meta">Research Summary · Cognitive Science</p>
    <h1 class="card-title">Deep Work Improves Output Quality More Than Total Hours Worked</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">A cross-sectional analysis of knowledge workers found that uninterrupted focus blocks correlated more strongly with output quality than total logged time. The effect remained significant after controlling for seniority, role type, and meeting load.</p>
    <p class="card-highlight card-accent-highlight-left">Focused sessions above 45 minutes predicted the largest quality gains</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel card-accent-panel-left">
        <p class="card-panel-title">Method</p>
        <p class="card-panel-text">312 participants across product, engineering, and research roles. Daily time diaries were paired with blinded manager quality ratings over six weeks.</p>
      </div>
      <div class="card-panel card-accent-panel-left">
        <p class="card-stat card-accent-stat">0.61</p>
        <p class="card-stat-label">Effect size</p>
      </div>
    </div>
    <span class="card-endmark">[1]</span>
    <div class="card-footer">Journal Club Note · Internal Literature Review</div>
  </div>
</div>