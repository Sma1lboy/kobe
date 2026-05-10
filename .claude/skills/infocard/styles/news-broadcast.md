# News Broadcast Style

**Style**: White newsroom card, red signal bars, bold condensed headlines, fast-scan urgency
**Best for**: Flash updates, status alerts, media-style recaps, executive bulletins, announcement cards

## Style Characteristics

| Property | Value |
|---|---|
| Background | White `#fffdfb` |
| Text | Broadcast black `#181818` |
| Accent | Signal red `#d62828` |
| Secondary | Slate `#4f4f4f` |
| Muted | News gray `#7a7a7a` |
| Tint | `rgba(214,40,40,0.05)` |
| Title Font | `Oswald`, `Inter`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Structure | Kicker + hard headline + ticker panels |
| Rules | Strong red vertical and horizontal dividers |

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; background: #fffdfb; padding: 38px 40px 34px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #181818; line-height: 1.6; border-left: 8px solid #d62828; }
    .card-meta { margin: 0 0 10px; font-size: 11px; font-weight: 800; letter-spacing: 0.18em; text-transform: uppercase; color: #d62828; }
    .card-title { margin: 0 0 14px; font-family: 'Oswald', 'Inter', sans-serif; font-size: 40px; font-weight: 700; line-height: 1.02; letter-spacing: -0.02em; color: #181818; text-transform: uppercase; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4f4f4f; max-width: 620px; }
    .card-bar { width: 90px; height: 6px; margin: 0 0 18px; background: #d62828; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.62; color: #303030; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.1fr 0.9fr; }
    .card-panel { padding: 14px 16px; background: rgba(214,40,40,0.05); }
    .card-accent-panel-top { border-top: 4px solid #d62828; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: #d62828; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.56; color: #4f4f4f; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 800; padding: 3px 8px; background: #d62828; color: #fffdfb; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.05em; }
    .card-stat { font-family: 'Oswald', 'Inter', sans-serif; font-size: 52px; font-weight: 700; line-height: 1; color: #d62828; margin: 0; }
    .card-accent-stat { color: #d62828; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #7a7a7a; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 66px/0.82 'Oswald', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #d62828; }
    .card-highlight { font-size: 16px; font-weight: 700; line-height: 1.5; color: #181818; padding: 10px 0 10px 16px; margin: 16px 0; }
    .card-accent-highlight-left { border-left: 4px solid #d62828; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #181818; }
    .card-divider { height: 1px; background: rgba(24,24,24,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #d62828; opacity: 0.35; margin-top: 20px; font-weight: 800; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(24,24,24,0.1); font-size: 11px; color: #7a7a7a; letter-spacing: 0.05em; }
  </style>
  <div class="card">
    <p class="card-meta">Breaking Update · Product Ops</p>
    <h1 class="card-title">Search Index Rebuild Finished 6 Hours Ahead of Plan</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The index migration concluded without rollback after the team parallelized re-ingestion and reduced duplicate document passes. Search freshness recovered first, followed by ranking stability after the last shard warmup finished.</p>
    <p class="card-highlight card-accent-highlight-left">No customer-visible downtime during switchover</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel card-accent-panel-top">
        <p class="card-panel-title">What Changed</p>
        <p class="card-panel-text">Deduplication moved upstream, shard balancing thresholds were relaxed, and cache rehydration started before the final cutover.</p>
      </div>
      <div class="card-panel card-accent-panel-top">
        <p class="card-stat card-accent-stat">18TB</p>
        <p class="card-stat-label">Reindexed corpus</p>
      </div>
    </div>
    <span class="card-endmark">LIVE</span>
    <div class="card-footer">Operations Desk · Morning Brief</div>
  </div>
</div>