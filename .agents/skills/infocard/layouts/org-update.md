# Org Update Layout

**Layout**: Team update card with changes, priorities, hiring, and ownership shifts in one view
**Best for**: Team changes, hiring updates, org redesigns, leadership communications, staffing summaries

## Template

<div style="max-width: 860px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafaf8; padding: 40px; font-family: sans-serif; color: #171717; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #171717; }
    .card-subtitle { margin: 0 0 18px; font-size: 15px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #171717; }
    .card-brief { display: grid; gap: 14px; }
    .card-brief-even { grid-template-columns: 1fr 1fr; }
    .card-panel { padding: 16px 18px; background: rgba(0,0,0,0.03); border-top: 4px solid #171717; }
    .card-panel.heavy { background: rgba(0,0,0,0.06); }
    .card-panel-title { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #666; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.58; color: #444; }
    .card-list { list-style: none; margin: 0; padding: 0; }
    .card-list li { position: relative; padding-left: 16px; margin-bottom: 8px; font-size: 13px; line-height: 1.55; color: #444; }
    .card-list li:last-child { margin-bottom: 0; }
    .card-list li::before { content: '•'; position: absolute; left: 0; color: #171717; }
    .card-statline { display: flex; gap: 16px; margin-top: 12px; flex-wrap: wrap; }
    .card-statbox { min-width: 120px; }
    .card-stat { margin: 0; font-size: 32px; font-weight: 700; line-height: 1; color: #171717; }
    .card-stat-label { margin: 4px 0 0; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #777; }
    .card-footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">People Update · Monthly Note</p>
    <h1 class="card-title">The Team Is Getting Smaller at the Center and Clearer at the Edges</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">This layout is for moments when the organization changes shape and the audience needs to understand who owns what, what hiring is next, and why the adjustment happened.</p>
    <div class="card-brief card-brief-even">
      <div class="card-panel heavy">
        <p class="card-panel-title">Structural Change</p>
        <p class="card-panel-text">Platform and export tooling now sit under one engineering manager, while customer education moved into support operations to reduce cross-functional drift.</p>
        <div class="card-statline">
          <div class="card-statbox"><p class="card-stat">27</p><p class="card-stat-label">Current headcount</p></div>
          <div class="card-statbox"><p class="card-stat">3</p><p class="card-stat-label">Open roles</p></div>
        </div>
      </div>
      <div class="card-panel">
        <p class="card-panel-title">Priority Hires</p>
        <ul class="card-list">
          <li>Senior frontend engineer for editor performance.</li>
          <li>Technical writer for template and export workflows.</li>
          <li>Solutions engineer for enterprise onboarding.</li>
        </ul>
      </div>
      <div class="card-panel">
        <p class="card-panel-title">Ownership Shifts</p>
        <ul class="card-list">
          <li>Preview renderer quality moves to platform.</li>
          <li>Release notes and migration comms move to CX.</li>
          <li>Template curation remains in product design.</li>
        </ul>
      </div>
      <div class="card-panel">
        <p class="card-panel-title">Why It Matters</p>
        <p class="card-panel-text">The change reduces coordination overhead in the core authoring loop and gives customer-facing teams clearer accountability during releases and onboarding.</p>
      </div>
    </div>
    <div class="card-footer">Leadership Update · Org Design Note</div>
  </div>
</div>