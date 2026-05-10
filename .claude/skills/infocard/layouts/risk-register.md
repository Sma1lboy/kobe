# Risk Register Layout

**Layout**: Structured risk table with severity, owner, mitigation, and time horizon fields
**Best for**: Risk tracking, compliance reviews, mitigation planning, governance notes, program oversight

## Template

<div style="max-width: 880px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fbfaf8; padding: 40px; font-family: sans-serif; color: #171717; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #171717; }
    .card-subtitle { margin: 0 0 18px; font-size: 15px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #171717; }
    .card-review-table { display: grid; gap: 10px; }
    .card-review-row { display: grid; grid-template-columns: 1.4fr 0.6fr 0.7fr 1fr 0.7fr; gap: 10px; align-items: start; }
    .card-review-row.header { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #777; }
    .card-review-cell { padding: 12px 14px; background: rgba(0,0,0,0.03); min-height: 56px; font-size: 13px; line-height: 1.52; color: #444; }
    .card-review-cell strong { color: #171717; }
    .risk-pill { display: inline-block; padding: 3px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
    .risk-pill.high { background: rgba(185,28,28,0.12); color: #b91c1c; }
    .risk-pill.medium { background: rgba(161,98,7,0.12); color: #a16207; }
    .risk-pill.low { background: rgba(21,128,61,0.12); color: #15803d; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Governance · Risk Register</p>
    <h1 class="card-title">Program Risk Snapshot</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Use this when the audience needs visible ownership and mitigation, not a vague paragraph about concerns. Keep entries current and operational.</p>
    <div class="card-review-table">
      <div class="card-review-row header">
        <div>Risk</div><div>Severity</div><div>Owner</div><div>Mitigation</div><div>Horizon</div>
      </div>
      <div class="card-review-row">
        <div class="card-review-cell"><strong>Export queue spikes during media-heavy launches</strong></div>
        <div class="card-review-cell"><span class="risk-pill high">High</span></div>
        <div class="card-review-cell">Platform</div>
        <div class="card-review-cell">Pre-scale workers, throttle duplicate jobs, add cache warming</div>
        <div class="card-review-cell">30 days</div>
      </div>
      <div class="card-review-row">
        <div class="card-review-cell"><strong>Plugin API drift may break external integrations</strong></div>
        <div class="card-review-cell"><span class="risk-pill medium">Medium</span></div>
        <div class="card-review-cell">SDK</div>
        <div class="card-review-cell">Contract tests, staged deprecation, versioned manifests</div>
        <div class="card-review-cell">60 days</div>
      </div>
      <div class="card-review-row">
        <div class="card-review-cell"><strong>Support load grows faster than documentation coverage</strong></div>
        <div class="card-review-cell"><span class="risk-pill medium">Medium</span></div>
        <div class="card-review-cell">CX</div>
        <div class="card-review-cell">Top-issue playbooks, in-product guidance, weekly ticket review</div>
        <div class="card-review-cell">Ongoing</div>
      </div>
    </div>
    <div class="card-footer">PMO · Monthly Governance Review</div>
  </div>
</div>