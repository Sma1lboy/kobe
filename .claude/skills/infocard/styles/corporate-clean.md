# Corporate Clean Style

**Style**: White surface, navy accents, conservative geometry, crisp enterprise tone
**Best for**: Product launches, B2B briefs, executive summaries, formal status reports, investor materials, startup pitches

## Style Characteristics

| Property | Value |
|---|---|
| Background | White `#ffffff` |
| Text | Ink navy `#1d2c44` |
| Accent | Corporate blue `#1f5aa6` |
| Secondary | Steel blue `#4f6b8f` |
| Muted | Report gray `#6c7a89` |
| Tint | `rgba(31,90,166,0.05)` |
| Title Font | `Inter`, `Noto Sans SC`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Surface | Clean, low-radius, no texture |

## Merge Note

This style now absorbs the previous role of `clean-modern`.

- `clean-modern` and `corporate-clean` shared the same core white-and-blue product/business language.
- `corporate-clean` is kept as the canonical file because it has broader enterprise coverage while still fitting product and launch use cases.

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; background: #ffffff; padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #1d2c44; line-height: 1.64; border: 1px solid rgba(29,44,68,0.08); }
    .card-surface-clean { border: 1px solid rgba(29,44,68,0.08); }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #6c7a89; }
    .card-title { margin: 0 0 16px; font-size: 34px; font-weight: 700; line-height: 1.14; letter-spacing: -0.02em; color: #1d2c44; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4f6b8f; }
    .card-bar { width: 80px; height: 4px; margin: 0 0 20px; background: #1f5aa6; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.66; color: #33455f; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.1fr 0.9fr; }
    .card-panel { padding: 16px 18px; background: rgba(31,90,166,0.05); border-top: 4px solid #1f5aa6; }
    .card-accent-panel-top { border-top: 4px solid #1f5aa6; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #1f5aa6; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.58; color: #4f6b8f; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: #1d2c44; color: #ffffff; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; }
    .card-stat { font-size: 46px; font-weight: 700; line-height: 1; color: #1f5aa6; margin: 0; }
    .card-accent-stat { color: #1f5aa6; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #6c7a89; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 64px/0.82 'Inter', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #1f5aa6; }
    .card-highlight { font-size: 16px; font-weight: 500; line-height: 1.55; color: #1d2c44; padding: 10px 0 10px 16px; border-left: 3px solid #1f5aa6; margin: 16px 0; }
    .card-accent-highlight-left { border-left: 3px solid #1f5aa6; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #1d2c44; }
    .card-divider { height: 1px; background: rgba(29,44,68,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #1f5aa6; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(29,44,68,0.1); font-size: 11px; color: #6c7a89; letter-spacing: 0.04em; }
  </style>
  <div class="card card-surface-clean">
    <p class="card-meta">Executive Brief · Q2</p>
    <h1 class="card-title">Commercial Pipeline Expanded While Delivery Risk Stayed Controlled</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The quarter combined stronger enterprise conversion with tighter execution discipline. New bookings grew faster than forecast, while implementation timelines remained within service targets despite higher onboarding volume.</p>
    <p class="card-highlight card-accent-highlight-left">Growth improved without forcing hidden delivery debt into the next quarter</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel card-accent-panel-top">
        <p class="card-panel-title">Commercial Signal</p>
        <p class="card-panel-text">Pipeline value increased across three existing verticals, with the strongest acceleration coming from expansion deals rather than logo acquisition alone.</p>
      </div>
      <div class="card-panel card-accent-panel-top">
        <p class="card-stat card-accent-stat">128%</p>
        <p class="card-stat-label">Net retention</p>
      </div>
    </div>
    <span class="card-endmark">BRIEF</span>
    <div class="card-footer">Leadership Review · Internal Distribution</div>
  </div>
</div>