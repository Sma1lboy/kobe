# Sales Room Style

**Style**: Revenue-floor clarity, dark ink headlines, green performance accents, concise commercial framing
**Best for**: Pipeline reviews, account snapshots, regional updates, deal strategy, weekly revenue briefings

## Style Characteristics

| Property | Value |
|---|---|
| Background | White `#fcfcfb` |
| Text | Deal black `#1d1f23` |
| Accent | Revenue green `#1c9a5f` |
| Secondary | Slate `#4a5563` |
| Muted | CRM gray `#79828d` |
| Tint | `rgba(28,154,95,0.06)` |
| Title Font | `Inter`, `Space Grotesk`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Surface | Clean commercial dashboard feel |

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; background: #fcfcfb; padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #1d1f23; line-height: 1.64; border: 1px solid rgba(29,31,35,0.07); }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #79828d; }
    .card-title { margin: 0 0 16px; font-size: 36px; font-weight: 700; line-height: 1.12; letter-spacing: -0.03em; color: #1d1f23; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a5563; }
    .card-bar { width: 78px; height: 5px; margin: 0 0 20px; background: #1c9a5f; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.66; color: #353c45; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.15fr 0.85fr; }
    .card-panel { padding: 16px 18px; background: rgba(28,154,95,0.06); border-top: 4px solid #1c9a5f; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #1c9a5f; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.58; color: #4a5563; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: rgba(28,154,95,0.1); color: #1c9a5f; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; }
    .card-stat { font-size: 50px; font-weight: 700; line-height: 1; color: #1c9a5f; margin: 0; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #79828d; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 66px/0.82 'Inter', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #1c9a5f; }
    .card-highlight { font-size: 16px; font-weight: 600; line-height: 1.54; color: #1d1f23; padding: 10px 0 10px 16px; border-left: 3px solid #1c9a5f; margin: 16px 0; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #1d1f23; }
    .card-divider { height: 1px; background: rgba(29,31,35,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #1c9a5f; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(29,31,35,0.1); font-size: 11px; color: #79828d; letter-spacing: 0.04em; }
  </style>
  <div class="card">
    <p class="card-meta">Revenue Review · North America</p>
    <h1 class="card-title">Late-Stage Pipeline Improved After Qualification Tightened</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The strongest shift this month was not more top-of-funnel volume. It was better opportunity quality. Once qualification tightened, late-stage conversion recovered and forecast confidence improved across the largest deals.</p>
    <p class="card-highlight">Fewer deals entered pipeline, but more of them became real revenue candidates</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel">
        <p class="card-panel-title">Commercial Signal</p>
        <p class="card-panel-text">Deal reviews now disqualify weak multi-threading earlier, which reduced wasted solution engineering time and clarified commit-stage ownership.</p>
      </div>
      <div class="card-panel">
        <p class="card-stat">41%</p>
        <p class="card-stat-label">Late-stage win rate</p>
      </div>
    </div>
    <span class="card-endmark">PIPELINE</span>
    <div class="card-footer">Sales Leadership · Weekly Room Readout</div>
  </div>
</div>