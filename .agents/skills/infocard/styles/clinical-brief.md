# Clinical Brief Style

**Style**: Calm medical palette, trustworthy blue-green accents, legible and patient-safe hierarchy
**Best for**: Healthcare summaries, clinical notes, patient education, care snapshots, medical overviews

## Style Characteristics

| Property | Value |
|---|---|
| Background | Clinical white `#f9fbfc` |
| Text | Medical slate `#22313f` |
| Accent | Care blue `#2f73b6` |
| Secondary | Wellness green `#3d8b77` |
| Muted | Record gray `#7c8a95` |
| Tint | `rgba(47,115,182,0.06)` |
| Title Font | `Inter`, `Noto Sans SC`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Surface | Calm, orderly, non-dramatic |

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #22313f; line-height: 1.66; border: 1px solid rgba(34,49,63,0.08); }
    .card-surface-paper { background: #f9fbfc; }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #7c8a95; }
    .card-title { margin: 0 0 16px; font-size: 34px; font-weight: 700; line-height: 1.14; letter-spacing: -0.02em; color: #22313f; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.62; color: #566976; }
    .card-bar { width: 80px; height: 4px; margin: 0 0 20px; background: #2f73b6; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.68; color: #3c4e5c; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.15fr 0.85fr; }
    .card-panel { padding: 16px 18px; background: rgba(47,115,182,0.06); }
    .card-accent-panel-left { border-left: 4px solid #3d8b77; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #3d8b77; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.6; color: #566976; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: rgba(47,115,182,0.1); color: #2f73b6; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; }
    .card-stat { font-size: 46px; font-weight: 700; line-height: 1; color: #2f73b6; margin: 0; }
    .card-accent-stat { color: #2f73b6; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #7c8a95; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 64px/0.82 'Inter', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #2f73b6; }
    .card-highlight { font-size: 16px; font-weight: 600; line-height: 1.56; color: #22313f; padding: 10px 0 10px 16px; margin: 16px 0; }
    .card-accent-highlight-left { border-left: 3px solid #2f73b6; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #22313f; }
    .card-divider { height: 1px; background: rgba(34,49,63,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #2f73b6; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(34,49,63,0.1); font-size: 11px; color: #7c8a95; letter-spacing: 0.04em; }
  </style>
  <div class="card card-surface-paper">
    <p class="card-meta">Clinical Summary · Care Note</p>
    <h1 class="card-title">Progress Depends More on Adherence Than on Intensifying the Plan</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The current care challenge is not treatment escalation. It is consistency. When medication timing, monitoring, and follow-up routines stabilize, the plan is more likely to produce measurable improvement than a premature change in regimen.</p>
    <p class="card-highlight card-accent-highlight-left">Steady execution often matters more than additional intervention</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel card-accent-panel-left">
        <p class="card-panel-title">Care Focus</p>
        <p class="card-panel-text">Reinforce adherence, simplify instructions, and confirm comprehension before revisiting dosage or adding adjacent interventions.</p>
      </div>
      <div class="card-panel card-accent-panel-left">
        <p class="card-stat card-accent-stat">2w</p>
        <p class="card-stat-label">Recommended follow-up interval</p>
      </div>
    </div>
    <span class="card-endmark">CARE</span>
    <div class="card-footer">Clinical Communication · Patient-Safe Summary</div>
  </div>
</div>