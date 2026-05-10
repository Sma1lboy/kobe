# Engineering Whiteprint Style

**Style**: White technical paper, graph-paper undertone, navy ink, monospace accents, precise structure
**Best for**: Architecture notes, API briefs, implementation plans, engineering whitepapers, technical summaries

## Style Characteristics

| Property | Value |
|---|---|
| Background | White `#fdfefe` |
| Text | Navy ink `#18314f` |
| Accent | Technical blue `#2f6fb6` |
| Muted | Steel `#5d6e82` |
| Tint | `rgba(47,111,182,0.05)` |
| Title Font | `Inter`, `Noto Sans SC`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Texture | Subtle graph grid overlay |
| Rules | 2px blueprint-like separators |

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; background: #fdfefe; padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #18314f; line-height: 1.64; }
    .card-surface-grid::before { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0.08; background-image: linear-gradient(rgba(47,111,182,0.45) 1px, transparent 1px), linear-gradient(90deg, rgba(47,111,182,0.45) 1px, transparent 1px); background-size: 22px 22px; }
    .card-text-mono { font-family: 'IBM Plex Mono', 'SF Mono', monospace; }
    .card-meta, .card-title, .card-subtitle, .card-bar, .card-body, .card-grid, .card-endmark, .card-footer { position: relative; }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #5d6e82; font-family: 'IBM Plex Mono', 'SF Mono', monospace; }
    .card-title { margin: 0 0 16px; font-size: 34px; font-weight: 700; line-height: 1.16; letter-spacing: -0.02em; color: #18314f; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.62; color: #38506a; }
    .card-bar { width: 82px; height: 2px; margin: 0 0 20px; background: #2f6fb6; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.68; color: #18314f; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.1fr 0.9fr; }
    .card-panel { padding: 16px 18px; background: rgba(47,111,182,0.05); border-top: 2px solid #2f6fb6; position: relative; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #2f6fb6; font-family: 'IBM Plex Mono', 'SF Mono', monospace; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.6; color: #38506a; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: rgba(47,111,182,0.08); color: #2f6fb6; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; font-family: 'IBM Plex Mono', 'SF Mono', monospace; }
    .card-stat { font-size: 44px; font-weight: 700; line-height: 1; color: #2f6fb6; margin: 0; font-family: 'IBM Plex Mono', 'SF Mono', monospace; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #5d6e82; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; font-family: 'IBM Plex Mono', monospace; }
    .card-body.dropcap::first-letter { font: 700 64px/0.82 'Inter', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #2f6fb6; }
    .card-highlight { font-size: 16px; font-weight: 500; line-height: 1.58; color: #18314f; padding: 10px 0 10px 16px; border-left: 2px solid #2f6fb6; margin: 16px 0; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #18314f; }
    .card-divider { height: 1px; background: rgba(24,49,79,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #2f6fb6; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(24,49,79,0.1); font-size: 11px; color: #5d6e82; letter-spacing: 0.04em; font-family: 'IBM Plex Mono', monospace; }
  </style>
  <div class="card card-surface-grid">
    <p class="card-meta card-text-mono">spec://api-gateway/v2</p>
    <h1 class="card-title">Gateway Contracts Move to Versioned Capability Flags</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The previous endpoint model encoded feature availability directly in route versioning, which made controlled rollout expensive. The new contract keeps stable routes while capability flags gate preview behavior at the schema layer.</p>
    <p class="card-highlight">Version numbers remain stable while behavior evolves behind explicit flags</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel">
        <p class="card-panel-title card-text-mono">Migration Path</p>
        <p class="card-panel-text">Introduce negotiated headers, deprecate route forks, and expose capability manifests in generated SDK metadata.</p>
      </div>
      <div class="card-panel">
        <p class="card-stat card-text-mono">12</p>
        <p class="card-stat-label card-text-mono">Endpoints simplified</p>
      </div>
    </div>
    <span class="card-endmark">::</span>
    <div class="card-footer card-text-mono">Platform RFC Snapshot · Rev 2.4</div>
  </div>
</div>