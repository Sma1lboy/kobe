# Swiss Grid Style

**Style**: Strict typographic alignment, strong grid discipline, black-red editorial contrast
**Best for**: Design-forward reports, structured statements, typographic summaries, editorial analysis

## Style Characteristics

| Property | Value |
|---|---|
| Background | Off-white `#fbfaf6` |
| Text | Near-black `#171717` |
| Accent | Signal red `#d63b2e` |
| Muted | Grid gray `#737373` |
| Tint | `rgba(0,0,0,0.03)` |
| Title Font | `Helvetica Neue`, `Arial`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Structure | Baseline rhythm and asymmetry through alignment, not ornament |

## Template

<div style="max-width: 840px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 840px; }
    .card { position: relative; background: #fbfaf6; padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #171717; line-height: 1.58; }
    .card::before { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0.08; background-image: linear-gradient(90deg, rgba(0,0,0,0.4) 1px, transparent 1px); background-size: calc(100% / 12) 100%; }
    .card-meta, .card-title, .card-subtitle, .card-bar, .card-body, .card-grid, .card-endmark, .card-footer { position: relative; }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: #737373; }
    .card-title { margin: 0 0 14px; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 40px; font-weight: 700; line-height: 0.98; letter-spacing: -0.04em; color: #171717; max-width: 560px; text-transform: uppercase; }
    .card-subtitle { margin: 0 0 18px; font-size: 15px; line-height: 1.58; color: #3f3f3f; max-width: 500px; margin-left: calc(100% / 12 * 3); }
    .card-bar { width: 72px; height: 6px; margin: 0 0 22px calc(100% / 12 * 3); background: #d63b2e; }
    .card-body { margin: 0 0 16px calc(100% / 12 * 3); font-size: 14px; line-height: 1.62; color: #2f2f2f; max-width: 500px; }
    .card-grid { display: grid; gap: 14px; margin-left: calc(100% / 12 * 3); }
    .card-grid-2 { grid-template-columns: 1fr 1fr; }
    .card-panel { padding: 14px 16px; background: rgba(0,0,0,0.03); border-top: 4px solid #171717; }
    .card-panel.heavy { border-top-color: #d63b2e; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #737373; }
    .card-panel-text { margin: 0; font-size: 13px; line-height: 1.56; color: #3f3f3f; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 7px; background: #171717; color: #fbfaf6; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; }
    .card-stat { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 56px; font-weight: 700; line-height: 1; color: #d63b2e; margin: 0; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #737373; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 72px/0.82 'Helvetica Neue', Arial, sans-serif; float: left; margin: 4px 12px 0 -2px; color: #d63b2e; }
    .card-highlight { font-size: 16px; font-weight: 600; line-height: 1.5; color: #171717; padding: 10px 0 10px 16px; border-left: 4px solid #d63b2e; margin: 16px 0 16px calc(100% / 12 * 3); max-width: 480px; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 14px; font-weight: 700; color: #171717; }
    .card-divider { height: 1px; background: rgba(0,0,0,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #d63b2e; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #737373; letter-spacing: 0.05em; }
  </style>
  <div class="card">
    <p class="card-meta">Editorial Analysis · Structured View</p>
    <h1 class="card-title">Complexity Grows Quietly Before It Fails Publicly</h1>
    <p class="card-subtitle">This style relies on disciplined offsets and typographic alignment rather than decorative surfaces. It works best when the content has one sharp thesis and several supporting claims.</p>
    <div class="card-bar"></div>
    <p class="card-body dropcap">Teams rarely notice complexity at the moment it is created. They notice it when speed falls, ownership blurs, and each small change starts carrying the emotional weight of a risky migration.</p>
    <p class="card-highlight">Visible simplicity often depends on invisible structural rigor</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel heavy">
        <p class="card-panel-title">Operational Signal</p>
        <p class="card-panel-text">Release coordination expands, exception paths multiply, and explanations get longer even when customer value does not.</p>
      </div>
      <div class="card-panel">
        <p class="card-stat">12</p>
        <p class="card-stat-label">handoffs removed in redesign</p>
      </div>
    </div>
    <span class="card-endmark">GRID</span>
    <div class="card-footer">Design Systems Review · Internal Essay</div>
  </div>
</div>