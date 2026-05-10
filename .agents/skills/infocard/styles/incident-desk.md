# Incident Desk Style

**Style**: Sharp operational palette, alert red and system slate, high-signal postmortem framing
**Best for**: Incident reviews, outage notes, postmortems, service degradation updates, reliability summaries

## Style Characteristics

| Property | Value |
|---|---|
| Background | Slate white `#f6f8fa` |
| Text | Ops charcoal `#20252d` |
| Accent | Incident red `#d14343` |
| Secondary | Steel blue `#5a6a7d` |
| Muted | Log gray `#818a95` |
| Tint | `rgba(209,67,67,0.06)` |
| Title Font | `Inter`, `IBM Plex Sans`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Surface | Operational and terse |

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; background: #f6f8fa; padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #20252d; line-height: 1.64; border: 1px solid rgba(32,37,45,0.08); }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #818a95; }
    .card-title { margin: 0 0 16px; font-size: 35px; font-weight: 700; line-height: 1.12; letter-spacing: -0.03em; color: #20252d; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #5a6a7d; }
    .card-bar { width: 82px; height: 5px; margin: 0 0 20px; background: #d14343; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.66; color: #39424d; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.15fr 0.85fr; }
    .card-panel { padding: 16px 18px; background: rgba(209,67,67,0.06); }
    .card-accent-panel-top { border-top: 4px solid #d14343; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #d14343; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.58; color: #5a6a7d; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: rgba(209,67,67,0.1); color: #d14343; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; }
    .card-stat { font-size: 48px; font-weight: 700; line-height: 1; color: #d14343; margin: 0; }
    .card-accent-stat { color: #d14343; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #818a95; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 66px/0.82 'Inter', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #d14343; }
    .card-highlight { font-size: 16px; font-weight: 600; line-height: 1.54; color: #20252d; padding: 10px 0 10px 16px; margin: 16px 0; }
    .card-accent-highlight-left { border-left: 3px solid #d14343; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #20252d; }
    .card-divider { height: 1px; background: rgba(32,37,45,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #d14343; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(32,37,45,0.1); font-size: 11px; color: #818a95; letter-spacing: 0.04em; }
  </style>
  <div class="card">
    <p class="card-meta">Incident Review · SEV-2</p>
    <h1 class="card-title">The Failure Lasted 19 Minutes, but the Weak Signal Existed for Weeks</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The visible outage came from a queue saturation event, but the deeper issue was threshold drift. Warning signals had already appeared in lag variance and retry concentration long before customer traffic amplified them into a page-worthy incident.</p>
    <p class="card-highlight card-accent-highlight-left">Short incidents often reveal long-running structural neglect</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel card-accent-panel-top">
        <p class="card-panel-title">Primary Failure Mode</p>
        <p class="card-panel-text">Consumer throughput fell below retry growth, which created a compounding queue wave once the malformed job pattern reappeared under higher load.</p>
      </div>
      <div class="card-panel card-accent-panel-top">
        <p class="card-stat card-accent-stat">19m</p>
        <p class="card-stat-label">User-visible degradation</p>
      </div>
    </div>
    <span class="card-endmark">SEV</span>
    <div class="card-footer">Reliability Review · Final Draft</div>
  </div>
</div>