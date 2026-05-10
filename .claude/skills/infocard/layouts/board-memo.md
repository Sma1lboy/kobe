# Board Memo Layout

**Layout**: Executive memo structure with thesis, decision asks, performance summary, and watchouts
**Best for**: Board updates, decision memos, quarterly leadership notes, formal executive communication

## Template

<div style="max-width: 860px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafaf8; padding: 40px; font-family: sans-serif; color: #181818; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #7a7a7a; }
    .card-title { margin: 0 0 14px; font-size: 32px; font-weight: 700; line-height: 1.15; color: #181818; max-width: 640px; }
    .card-subtitle { margin: 0 0 18px; font-size: 15px; line-height: 1.58; color: #444; max-width: 640px; }
    .card-bar { width: 84px; height: 6px; margin: 0 0 22px; background: #181818; }
    .card-doc { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 16px; }
    .card-doc-main { display: grid; gap: 14px; }
    .card-section { padding: 16px 18px; background: rgba(0,0,0,0.03); border-top: 4px solid #181818; }
    .card-section-title { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #666; }
    .card-section-text { margin: 0; font-size: 14px; line-height: 1.58; color: #444; }
    .card-doc-list { list-style: none; margin: 0; padding: 0; }
    .card-doc-list li { position: relative; padding-left: 16px; margin-bottom: 8px; font-size: 13px; line-height: 1.55; color: #444; }
    .card-doc-list li:last-child { margin-bottom: 0; }
    .card-doc-list.arrow li::before { content: '→'; position: absolute; left: 0; color: #181818; font-weight: 700; }
    .card-doc-list.alert li::before { content: '!'; position: absolute; left: 0; color: #181818; font-weight: 700; }
    .card-doc-side { display: grid; gap: 14px; }
    .card-section.card-section-stat { padding: 18px; background: rgba(0,0,0,0.06); }
    .card-kpi-value { margin: 0; font-size: 44px; font-weight: 700; line-height: 1; color: #181818; }
    .card-kpi-label { margin: 6px 0 0; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #777; }
    .card-footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Board Memo · Quarterly Review</p>
    <h1 class="card-title">Expansion Stayed Ahead of Plan, But Delivery Capacity Is Now the Constraint</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Use this format when leadership needs a compact written memo rather than a decorative overview. The point is to make the actual decision surface explicit.</p>
    <div class="card-doc">
      <div class="card-doc-main">
        <div class="card-section">
          <p class="card-section-title">Core Judgment</p>
          <p class="card-section-text">Commercial performance remained strong, and retention improved. The largest near-term risk is now implementation throughput rather than demand generation.</p>
        </div>
        <div class="card-section">
          <p class="card-section-title">Board Asks</p>
          <ul class="card-doc-list arrow">
            <li>Approve hiring plan for services delivery and onboarding operations.</li>
            <li>Support a narrower product roadmap for the next two quarters.</li>
            <li>Confirm reserve policy for selective enterprise pre-sales investment.</li>
          </ul>
        </div>
      </div>
      <div class="card-doc-side">
        <div class="card-section card-section-stat">
          <p class="card-kpi-value">31%</p>
          <p class="card-kpi-label">QoQ bookings growth</p>
        </div>
        <div class="card-section">
          <p class="card-section-title">Watchouts</p>
          <ul class="card-doc-list alert">
            <li>Enterprise onboarding timelines lengthened by 9 days.</li>
            <li>PM capacity is being diluted across too many customer-specific requests.</li>
          </ul>
        </div>
      </div>
    </div>
    <div class="card-footer">Board Pack · Memo Excerpt</div>
  </div>
</div>