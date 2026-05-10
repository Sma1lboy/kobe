# Sales Brief Layout

**Layout**: Revenue memo with top-line quota view, pipeline segment blocks, and deal focus area
**Best for**: Pipeline reviews, regional sales updates, forecast calls, deal strategy notes, weekly revenue briefs

## Template

<div style="max-width: 860px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafaf8; padding: 40px; font-family: sans-serif; color: #171717; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #171717; }
    .card-subtitle { margin: 0 0 18px; font-size: 15px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #171717; }
    .card-doc { display: grid; grid-template-columns: 0.9fr 1.1fr; gap: 14px; margin-bottom: 14px; }
    .card-section, .card-section.card-section-stat { padding: 16px 18px; background: rgba(0,0,0,0.03); border-top: 4px solid #171717; }
    .card-kpi-value { margin: 0; font-size: 44px; font-weight: 700; line-height: 1; color: #171717; }
    .card-kpi-label { margin: 6px 0 0; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #777; }
    .card-section-title { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #666; }
    .card-section-text { margin: 0; font-size: 14px; line-height: 1.58; color: #444; }
    .card-kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .card-kpi { padding: 14px 16px; background: rgba(0,0,0,0.03); border-top: 4px solid #171717; }
    .card-kpi-title { margin: 0 0 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #666; }
    .card-kpi-text { margin: 0; font-size: 13px; line-height: 1.55; color: #444; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Revenue Operations · Weekly Brief</p>
    <h1 class="card-title">Forecast Quality Improved Even as Top-of-Funnel Slowed</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">This layout works when the core message is a commercial readout: what the number is, why it changed, and which parts of the pipeline actually matter.</p>
    <div class="card-doc">
      <div class="card-section card-section-stat">
        <p class="card-kpi-value">87%</p>
        <p class="card-kpi-label">Quarter-to-date quota attainment</p>
      </div>
      <div class="card-section">
        <p class="card-section-title">Readout</p>
        <p class="card-section-text">Coverage remains healthy, but the more important shift is conversion quality in the commit tier. Larger deals are advancing with stronger multi-threading and cleaner success criteria than last month.</p>
      </div>
    </div>
    <div class="card-kpi-grid">
      <div class="card-kpi">
        <p class="card-kpi-title">Pipeline</p>
        <p class="card-kpi-text">Fewer new opportunities, but improved qualification and cleaner stage hygiene.</p>
      </div>
      <div class="card-kpi">
        <p class="card-kpi-title">Deals at Risk</p>
        <p class="card-kpi-text">Two enterprise renewals depend on procurement timing rather than product fit.</p>
      </div>
      <div class="card-kpi">
        <p class="card-kpi-title">Priority Action</p>
        <p class="card-kpi-text">Pull solution engineering earlier into strategic accounts with complex rollout requirements.</p>
      </div>
    </div>
    <div class="card-footer">Commercial Review · Internal Use</div>
  </div>
</div>