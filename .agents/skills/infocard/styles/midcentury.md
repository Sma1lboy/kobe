# Midcentury Style

**Style**: Cream base, mustard-teal-rust palette, geometric warmth, poster-like storytelling
**Best for**: Brand stories, retro-modern campaigns, culture notes, design narratives, creative summaries

## Style Characteristics

| Property | Value |
|---|---|
| Background | Cream `#f6efe1` |
| Text | Walnut `#332a24` |
| Accent | Rust `#b55233` |
| Secondary | Teal `#3f7c78` |
| Tertiary | Mustard `#d3a23a` |
| Muted | Cocoa `#77655b` |
| Surface | Soft geometric blocks and poster contrast |
| Title Font | `Space Grotesk`, `Inter`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |

## Template

<div style="max-width: 840px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 840px; }
    .card { position: relative; padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #332a24; line-height: 1.64; }
    .card-surface-warm { background: #f6efe1; }
    .card-surface-graphic::before { content: ''; position: absolute; right: -36px; top: -24px; width: 180px; height: 180px; border-radius: 50%; background: rgba(63,124,120,0.14); }
    .card-surface-graphic::after { content: ''; position: absolute; left: -20px; bottom: -24px; width: 160px; height: 160px; background: rgba(211,162,58,0.16); transform: rotate(24deg); }
    .card-meta, .card-title, .card-subtitle, .card-bar, .card-body, .card-grid, .card-endmark, .card-footer { position: relative; }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #77655b; }
    .card-title { margin: 0 0 16px; font-family: 'Space Grotesk', 'Inter', sans-serif; font-size: 38px; font-weight: 700; line-height: 1.06; letter-spacing: -0.03em; color: #332a24; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.62; color: #5a4a43; max-width: 620px; }
    .card-bar { width: 86px; height: 6px; margin: 0 0 20px; background: linear-gradient(90deg, #b55233 0%, #d3a23a 100%); }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.68; color: #332a24; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.1fr 0.9fr; }
    .card-panel { padding: 16px 18px; background: rgba(255,255,255,0.34); }
    .card-accent-panel-left { border-left: 4px solid #3f7c78; }
    .card-panel.heavy { border-left-color: #b55233; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #3f7c78; }
    .card-panel.heavy .card-panel-title { color: #b55233; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.58; color: #5a4a43; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: #332a24; color: #f6efe1; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; }
    .card-stat { font-family: 'Space Grotesk', 'Inter', sans-serif; font-size: 50px; font-weight: 700; line-height: 1; color: #b55233; margin: 0; }
    .card-accent-stat { color: #b55233; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #77655b; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 66px/0.82 'Space Grotesk', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #3f7c78; }
    .card-highlight { font-size: 16px; font-weight: 600; line-height: 1.54; color: #332a24; padding: 10px 0 10px 16px; margin: 16px 0; }
    .card-accent-highlight-left { border-left: 4px solid #d3a23a; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #332a24; }
    .card-divider { height: 1px; background: rgba(51,42,36,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #b55233; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(51,42,36,0.1); font-size: 11px; color: #77655b; letter-spacing: 0.04em; }
  </style>
  <div class="card card-surface-warm card-surface-graphic">
    <p class="card-meta">Brand Story · Studio Note</p>
    <h1 class="card-title">The Identity Became Warmer When the System Became Simpler</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The redesign did not add personality through decoration. It recovered personality by removing noise. Once the information system stopped shouting, the tone of the brand could finally emerge as calm, human, and recognizable.</p>
    <p class="card-highlight card-accent-highlight-left">Restraint gave the brand a more memorable voice</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel card-accent-panel-left heavy">
        <p class="card-panel-title">Visual Shift</p>
        <p class="card-panel-text">A reduced palette, firmer type hierarchy, and recurring geometric anchors replaced the previous collage of inconsistent emphasis.</p>
      </div>
      <div class="card-panel card-accent-panel-left">
        <p class="card-stat card-accent-stat">4</p>
        <p class="card-stat-label">core shapes in the new system</p>
      </div>
    </div>
    <span class="card-endmark">ARC</span>
    <div class="card-footer">Design Retrospective · Identity System</div>
  </div>
</div>