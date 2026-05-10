# Quadrant Matrix Layout

**Layout**: Two-axis 2x2 matrix with one emphasized quadrant and labeled decision frame
**Best for**: Priority mapping, effort-impact analysis, portfolio classification, risk-return framing

## Template

<div style="max-width: 860px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafafa; padding: 40px; font-family: sans-serif; color: #111; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #111; }
    .card-subtitle { margin: 0 0 20px; font-size: 15px; line-height: 1.55; color: #444; max-width: 620px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #111; }
    .card-matrix-wrap { position: relative; padding: 24px 18px 12px 72px; }
    .card-axis-y { position: absolute; left: 0; top: 50%; transform: translateY(-50%) rotate(-90deg); transform-origin: left top; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #777; }
    .card-axis-x { text-align: center; margin-top: 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #777; }
    .card-map-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .card-map-zone { min-height: 150px; padding: 16px; background: rgba(0,0,0,0.03); border-top: 4px solid #111; }
    .card-map-zone.focus { background: rgba(0,0,0,0.06); }
    .card-map-zone-label { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #777; }
    .card-map-zone-title { margin: 0 0 8px; font-size: 16px; font-weight: 700; color: #111; }
    .card-map-zone-text { margin: 0; font-size: 13px; line-height: 1.55; color: #444; }
    .card-footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Strategy Tool · 2x2 Matrix</p>
    <h1 class="card-title">Feature Prioritization Frame</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">A good matrix is not a dumping ground. Use it to separate what should ship now, what deserves incubation, and what only looks attractive until cost is considered.</p>
    <div class="card-matrix-wrap">
      <div class="card-axis-y">Impact</div>
      <div class="card-map-grid">
        <div class="card-map-zone">
          <p class="card-map-zone-label">High Impact / Low Effort</p>
          <p class="card-map-zone-title">Quick Wins</p>
          <p class="card-map-zone-text">Polish search filters, tighten empty states, add export presets.</p>
        </div>
        <div class="card-map-zone focus">
          <p class="card-map-zone-label">High Impact / High Effort</p>
          <p class="card-map-zone-title">Strategic Bets</p>
          <p class="card-map-zone-text">Unified workspace memory, cross-device sync, presentation authoring flow.</p>
        </div>
        <div class="card-map-zone">
          <p class="card-map-zone-label">Low Impact / Low Effort</p>
          <p class="card-map-zone-title">Backlog Fillers</p>
          <p class="card-map-zone-text">Minor icon variants, niche preference toggles, cosmetic spacing options.</p>
        </div>
        <div class="card-map-zone">
          <p class="card-map-zone-label">Low Impact / High Effort</p>
          <p class="card-map-zone-title">Defer</p>
          <p class="card-map-zone-text">Custom scripting DSL, rarely used import bridges, experimental white-label shells.</p>
        </div>
      </div>
      <div class="card-axis-x">Effort</div>
    </div>
    <div class="card-footer">Product Planning · Decision Surface</div>
  </div>
</div>