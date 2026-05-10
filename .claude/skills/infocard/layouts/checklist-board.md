# Checklist Board Layout

**Layout**: Structured readiness board with checked, in-progress, and blocked work clearly separated
**Best for**: Launch readiness, QA gates, operational checklists, audit prep, shipping criteria

## Template

<div style="max-width: 840px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafaf8; padding: 40px; font-family: sans-serif; color: #151515; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #151515; }
    .card-subtitle { margin: 0 0 20px; font-size: 15px; line-height: 1.55; color: #444; max-width: 620px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #151515; }
    .card-tile-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
    .card-tile { padding: 18px; background: rgba(0,0,0,0.03); border-top: 4px solid #151515; }
    .card-tile-title { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #666; }
    .card-tile-list { list-style: none; margin: 0; padding: 0; }
    .card-tile-list li { position: relative; margin-bottom: 10px; padding-left: 24px; font-size: 13px; line-height: 1.55; color: #444; }
    .card-tile-list li:last-child { margin-bottom: 0; }
    .card-tile-list li::before { position: absolute; left: 0; top: 0; font-weight: 700; }
    .card-tile-list.done li::before { content: '✓'; color: #15803d; }
    .card-tile-list.progress li::before { content: '•'; color: #a16207; }
    .card-tile-list.blocked li::before { content: '×'; color: #b91c1c; }
    .card-footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Launch Readiness · Checklist</p>
    <h1 class="card-title">v3.2 Release Gate Review</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">This layout works best when the actual shipping decision depends on visible completion states, not on long prose. Keep items concrete and binary when possible.</p>
    <div class="card-tile-grid">
      <div class="card-tile">
        <p class="card-tile-title">Done</p>
        <ul class="card-tile-list done">
          <li>Regression suite green across desktop and web.</li>
          <li>Localization keys synced and verified.</li>
          <li>Crash-free session target met in canary.</li>
        </ul>
      </div>
      <div class="card-tile">
        <p class="card-tile-title">In Progress</p>
        <ul class="card-tile-list progress">
          <li>Migration note review with support team.</li>
          <li>Release announcement screenshots refresh.</li>
          <li>Final perf trace on low-memory devices.</li>
        </ul>
      </div>
      <div class="card-tile">
        <p class="card-tile-title">Blocked</p>
        <ul class="card-tile-list blocked">
          <li>Waiting on App Store review status.</li>
          <li>One export edge case still lacks owner sign-off.</li>
        </ul>
      </div>
    </div>
    <div class="card-footer">Release Ops · Decision Review</div>
  </div>
</div>