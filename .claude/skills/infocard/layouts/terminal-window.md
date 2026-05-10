# Terminal Window Layout

**Layout**: Faux terminal frame with command output, status badges, and a right-side summary block
**Best for**: Incident updates, CLI walkthroughs, deployment notes, audit logs, operational snapshots

## Template

<div style="max-width: 840px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #0a1110; padding: 0; font-family: 'IBM Plex Mono', 'SF Mono', monospace; color: #d8fdd8; line-height: 1.6; overflow: hidden; }
    .terminal-topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: #111b19; border-bottom: 1px solid rgba(125,255,160,0.12); }
    .terminal-lights { display: flex; gap: 8px; }
    .terminal-light { width: 10px; height: 10px; border-radius: 50%; }
    .terminal-light.red { background: #ff7b72; }
    .terminal-light.yellow { background: #f2cc60; }
    .terminal-light.green { background: #43f08f; }
    .terminal-title { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #6ab27d; }
    .terminal-body { padding: 28px; display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 16px; }
    .terminal-meta { margin: 0 0 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #6ab27d; }
    .terminal-title-main { margin: 0 0 14px; font-size: 28px; font-weight: 700; line-height: 1.2; color: #43f08f; }
    .terminal-log { margin: 0; padding: 16px; background: rgba(67,240,143,0.06); border: 1px solid rgba(67,240,143,0.14); min-height: 240px; white-space: pre-wrap; font-size: 13px; line-height: 1.7; color: #d8fdd8; }
    .card-doc-side { display: grid; gap: 12px; }
    .card-section { padding: 16px; background: rgba(67,240,143,0.06); border: 1px solid rgba(67,240,143,0.14); }
    .card-section-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #43f08f; }
    .card-section-text { margin: 0; font-size: 13px; line-height: 1.6; color: #b9e8bf; }
    .card-doc-badge { display: inline-block; margin-right: 6px; margin-bottom: 6px; padding: 3px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; border: 1px solid rgba(67,240,143,0.16); color: #43f08f; }
    .terminal-footer { padding: 12px 28px 20px; font-size: 11px; color: #6ab27d; border-top: 1px solid rgba(67,240,143,0.1); }
  </style>
  <div class="card">
    <div class="terminal-topbar">
      <div class="terminal-lights">
        <span class="terminal-light red"></span>
        <span class="terminal-light yellow"></span>
        <span class="terminal-light green"></span>
      </div>
      <span class="terminal-title">deploy-monitor</span>
    </div>
    <div class="terminal-body">
      <div>
        <p class="terminal-meta">Deployment · Snapshot</p>
        <h1 class="terminal-title-main">Blue-Green Switch Completed</h1>
        <pre class="terminal-log">$ deploy release --target=green
pulling image digest... ok
running smoke suite... ok
shifting 10% traffic... ok
shifting 50% traffic... ok
promoting green to primary... ok
retiring blue pool... ok
summary: 6 checks passed, rollback not required</pre>
      </div>
      <div class="card-doc-side">
        <div class="card-section">
          <p class="card-section-title">Status</p>
          <p class="card-section-text"><span class="card-doc-badge">healthy</span><span class="card-doc-badge">no rollback</span><span class="card-doc-badge">latency stable</span></p>
        </div>
        <div class="card-section">
          <p class="card-section-title">Operator Notes</p>
          <p class="card-section-text">The only drift detected was a stale feature flag payload in one edge node, resolved during the 10% canary phase before customer impact.</p>
        </div>
        <div class="card-section">
          <p class="card-section-title">Impact</p>
          <p class="card-section-text">P95 latency stayed within 3% of baseline while error rate remained below alert threshold for the full promotion window.</p>
        </div>
      </div>
    </div>
    <div class="terminal-footer">Release Console · 2026-04-17 08:43 UTC</div>
  </div>
</div>