# Financial Snapshot Layout

**Layout**: Top-line financial summary with KPI strip, one key narrative block, and unit-economics detail
**Best for**: Revenue summaries, cash views, margin snapshots, unit economics, finance update cards

## Template

<div style="max-width: 860px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafaf8; padding: 40px; font-family: sans-serif; color: #171717; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #171717; }
    .card-subtitle { margin: 0 0 18px; font-size: 15px; line-height: 1.55; color: #444; max-width: 620px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #171717; }
    .card-kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
    .card-kpi { padding: 16px; background: rgba(0,0,0,0.03); border-top: 4px solid #171717; }
    .card-kpi-value { margin: 0; font-size: 30px; font-weight: 700; line-height: 1; color: #171717; }
    .card-kpi-label { margin: 6px 0 0; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #777; }
    .card-kpi-delta { margin: 4px 0 0; font-size: 12px; font-weight: 700; color: #156f3c; }
    .card-doc { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 14px; }
    .card-section { padding: 16px 18px; background: rgba(0,0,0,0.03); border-top: 4px solid #171717; }
    .card-section-title { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #666; }
    .card-section-text { margin: 0; font-size: 14px; line-height: 1.58; color: #444; }
    .card-doc-list { list-style: none; margin: 0; padding: 0; }
    .card-doc-list.metric li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid rgba(0,0,0,0.08); font-size: 13px; color: #444; }
    .card-doc-list.metric li:last-child { border-bottom: none; }
    .card-doc-list.metric strong { color: #171717; }
    .card-footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Finance Update · Monthly Snapshot</p>
    <h1 class="card-title">Top-Line Growth Outpaced Spend Expansion</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">This layout works when finance needs to explain not just the numbers, but the relationship between revenue, burn, and efficiency in one compact surface.</p>
    <div class="card-kpi-grid">
      <div class="card-kpi"><p class="card-kpi-value">$2.8M</p><p class="card-kpi-label">ARR Added</p><p class="card-kpi-delta">+24% vs plan</p></div>
      <div class="card-kpi"><p class="card-kpi-value">78%</p><p class="card-kpi-label">Gross Margin</p><p class="card-kpi-delta">+3 pts</p></div>
      <div class="card-kpi"><p class="card-kpi-value">19m</p><p class="card-kpi-label">Runway</p><p class="card-kpi-delta">+2 months</p></div>
      <div class="card-kpi"><p class="card-kpi-value">11m</p><p class="card-kpi-label">CAC Payback</p><p class="card-kpi-delta">-1 month</p></div>
    </div>
    <div class="card-doc">
      <div class="card-section">
        <p class="card-section-title">Narrative</p>
        <p class="card-section-text">Margin expansion came from mix shift toward enterprise and lower support intensity per account. Hiring remained below plan, which preserved burn but cannot continue indefinitely without slowing implementation throughput.</p>
      </div>
      <div class="card-section">
        <p class="card-section-title">Unit Economics</p>
        <ul class="card-doc-list metric">
          <li><span>Net Revenue Retention</span><strong>126%</strong></li>
          <li><span>LTV / CAC</span><strong>5.1x</strong></li>
          <li><span>Monthly Burn</span><strong>$410K</strong></li>
          <li><span>Cash Balance</span><strong>$6.5M</strong></li>
        </ul>
      </div>
    </div>
    <div class="card-footer">FP&A · Internal Snapshot</div>
  </div>
</div>