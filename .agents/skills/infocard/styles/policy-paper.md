# Policy Paper Style

**Style**: Formal document tone, muted charcoal, sober blue accents, governance-first readability
**Best for**: Governance notes, internal rules, policy explainers, operational guidance, legal-adjacent summaries

## Style Characteristics

| Property | Value |
|---|---|
| Background | Paper white `#fbfbf9` |
| Text | Charcoal `#25272b` |
| Accent | Rule blue `#46648f` |
| Secondary | Policy gray `#5f6772` |
| Muted | Archive gray `#848b94` |
| Tint | `rgba(70,100,143,0.05)` |
| Title Font | `Noto Serif SC`, `Georgia`, serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Surface | Quiet, memo-like, restrained |

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; padding: 42px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #25272b; line-height: 1.68; border: 1px solid rgba(37,39,43,0.08); }
    .card-surface-paper { background: #fbfbf9; }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #848b94; }
    .card-title { margin: 0 0 16px; font-family: 'Noto Serif SC', Georgia, serif; font-size: 36px; font-weight: 700; line-height: 1.18; letter-spacing: -0.02em; color: #25272b; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.64; color: #5f6772; }
    .card-bar { width: 72px; height: 2px; margin: 0 0 22px; background: #46648f; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.72; color: #383c43; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.15fr 0.85fr; }
    .card-panel { padding: 16px 18px; background: rgba(70,100,143,0.05); }
    .card-accent-panel-left { border-left: 3px solid #46648f; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #46648f; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.62; color: #5f6772; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: rgba(70,100,143,0.08); color: #46648f; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; }
    .card-stat { font-size: 44px; font-weight: 700; line-height: 1; color: #46648f; margin: 0; }
    .card-accent-stat { color: #46648f; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #848b94; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 68px/0.84 'Noto Serif SC', Georgia, serif; float: left; margin: 4px 12px 0 -2px; color: #46648f; }
    .card-highlight { font-size: 16px; font-weight: 500; line-height: 1.6; color: #25272b; padding: 10px 0 10px 16px; margin: 16px 0; }
    .card-accent-highlight-left { border-left: 3px solid #46648f; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #25272b; }
    .card-divider { height: 1px; background: rgba(37,39,43,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #46648f; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(37,39,43,0.1); font-size: 11px; color: #848b94; letter-spacing: 0.04em; }
  </style>
  <div class="card card-surface-paper">
    <p class="card-meta">Governance Note · Policy Revision</p>
    <h1 class="card-title">Exceptions Should Be Documented Before They Are Operationalized</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">Most policy debt is created when teams treat urgent operational exceptions as temporary, then silently normalize them. This revision makes approval, duration, and owner requirements explicit before any exception enters live practice.</p>
    <p class="card-highlight card-accent-highlight-left">Temporary behavior becomes permanent unless policy names the boundary first</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel card-accent-panel-left">
        <p class="card-panel-title">Policy Change</p>
        <p class="card-panel-text">All production exceptions now require defined expiry dates, documented rationale, and named approvers, with monthly review until closure.</p>
      </div>
      <div class="card-panel card-accent-panel-left">
        <p class="card-stat card-accent-stat">30d</p>
        <p class="card-stat-label">Maximum default exception term</p>
      </div>
    </div>
    <span class="card-endmark">POLICY</span>
    <div class="card-footer">Internal Governance Office · Revision Summary</div>
  </div>
</div>