# Trust Center Style

**Style**: Calm security aesthetic, steel-blue surface, restrained green assurances, audit-friendly clarity
**Best for**: Security notes, compliance summaries, trust reports, control updates, audit communications

## Style Characteristics

| Property | Value |
|---|---|
| Background | Pale steel `#f6f8fb` |
| Text | Security navy `#213247` |
| Accent | Assurance green `#2f855a` |
| Secondary | Cloud blue `#56708b` |
| Muted | Control gray `#7d8a98` |
| Tint | `rgba(47,133,90,0.06)` |
| Title Font | `Inter`, `Noto Sans SC`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Surface | Trust-center documentation feel |

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; background: #f6f8fb; padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #213247; line-height: 1.64; border: 1px solid rgba(33,50,71,0.08); }
    .card-surface-clean { border: 1px solid rgba(33,50,71,0.08); }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #7d8a98; }
    .card-title { margin: 0 0 16px; font-size: 34px; font-weight: 700; line-height: 1.14; letter-spacing: -0.02em; color: #213247; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #56708b; }
    .card-bar { width: 80px; height: 4px; margin: 0 0 20px; background: #2f855a; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.66; color: #3d536b; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.1fr 0.9fr; }
    .card-panel { padding: 16px 18px; background: rgba(47,133,90,0.06); border-top: 4px solid #2f855a; }
    .card-accent-panel-top { border-top: 4px solid #2f855a; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #2f855a; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.58; color: #56708b; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: rgba(47,133,90,0.1); color: #2f855a; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; }
    .card-stat { font-size: 46px; font-weight: 700; line-height: 1; color: #2f855a; margin: 0; }
    .card-accent-stat { color: #2f855a; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #7d8a98; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 64px/0.82 'Inter', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #2f855a; }
    .card-highlight { font-size: 16px; font-weight: 600; line-height: 1.54; color: #213247; padding: 10px 0 10px 16px; border-left: 3px solid #2f855a; margin: 16px 0; }
    .card-accent-highlight-left { border-left: 3px solid #2f855a; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #213247; }
    .card-divider { height: 1px; background: rgba(33,50,71,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #2f855a; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(33,50,71,0.1); font-size: 11px; color: #7d8a98; letter-spacing: 0.04em; }
  </style>
  <div class="card card-surface-clean">
    <p class="card-meta">Trust Update · Security Posture</p>
    <h1 class="card-title">Control Coverage Expanded Faster Than Audit Scope</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">This quarter's trust work focused on turning ad hoc operational habits into documented, reviewable controls. The biggest gain came from clarifying evidence collection before the next audit window rather than waiting for external requests to define the workload.</p>
    <p class="card-highlight card-accent-highlight-left">Preparation quality now reduces audit friction before the audit begins</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel card-accent-panel-top">
        <p class="card-panel-title">Control Area</p>
        <p class="card-panel-text">Access review cadence, incident evidence retention, vendor inventory freshness, and change approval traceability were all brought under one reporting rhythm.</p>
      </div>
      <div class="card-panel card-accent-panel-top">
        <p class="card-stat card-accent-stat">94%</p>
        <p class="card-stat-label">Mapped control coverage</p>
      </div>
    </div>
    <span class="card-endmark">TRUST</span>
    <div class="card-footer">Security & Compliance · Quarterly Note</div>
  </div>
</div>