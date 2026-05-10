# Badge Grid Layout

**Layout**: Grid of labeled badges or icons with short descriptions
**Best for**: Feature lists, capability catalogs, skill inventories, benefit showcases, toolkits

## Template

<div style="max-width: 800px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafafa; padding: 40px; font-family: sans-serif; color: #111; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #111; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 12px; background: #111; }
    .card-body { margin: 0 0 20px; font-size: 15px; color: #333; }
    .card-tile-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .card-tile { padding: 18px 12px; background: rgba(0,0,0,0.03); }
    .card-tile-center { display: flex; flex-direction: column; align-items: center; text-align: center; }
    .card-tile-icon { font-size: 28px; margin-bottom: 8px; line-height: 1; }
    .card-tile-title { margin: 0 0 4px; font-size: 13px; font-weight: 700; color: #111; }
    .card-tile-text { margin: 0; font-size: 12px; line-height: 1.45; color: #666; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #999; }
  </style>
  <div class="card">
    <p class="card-meta">Capabilities · Platform</p>
    <h1 class="card-title">What Ships Out of the Box</h1>
    <div class="card-bar"></div>
    <p class="card-body">Every deployment includes these core capabilities, configured and ready to use from day one.</p>
    <div class="card-tile-grid">
      <div class="card-tile card-tile-center">
        <span class="card-tile-icon">&#x1F512;</span>
        <p class="card-tile-title">Auth &amp; SSO</p>
        <p class="card-tile-text">SAML, OIDC, and MFA with configurable session policies</p>
      </div>
      <div class="card-tile card-tile-center">
        <span class="card-tile-icon">&#x1F4CA;</span>
        <p class="card-tile-title">Analytics</p>
        <p class="card-tile-text">Real-time dashboards with custom event tracking and funnels</p>
      </div>
      <div class="card-tile card-tile-center">
        <span class="card-tile-icon">&#x1F310;</span>
        <p class="card-tile-title">CDN</p>
        <p class="card-tile-text">Global edge caching across 42 PoPs with automatic purge</p>
      </div>
      <div class="card-tile card-tile-center">
        <span class="card-tile-icon">&#x1F514;</span>
        <p class="card-tile-title">Alerts</p>
        <p class="card-tile-text">Threshold and anomaly-based alerts via Slack, email, PagerDuty</p>
      </div>
      <div class="card-tile card-tile-center">
        <span class="card-tile-icon">&#x1F504;</span>
        <p class="card-tile-title">CI/CD</p>
        <p class="card-tile-text">Git-push deploys with preview environments and rollback</p>
      </div>
      <div class="card-tile card-tile-center">
        <span class="card-tile-icon">&#x1F4DD;</span>
        <p class="card-tile-title">Audit Log</p>
        <p class="card-tile-text">Immutable event log with 90-day retention and SIEM export</p>
      </div>
    </div>
    <div class="card-footer">Platform Capabilities · Standard Tier</div>
  </div>
</div>
