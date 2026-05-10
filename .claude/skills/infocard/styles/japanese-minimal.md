# Japanese Minimal Style

**Style**: Ivory paper, restrained vermilion accent, quiet serif headline, large negative space
**Best for**: Brand narratives, cultural notes, reflective essays, premium product notes

## Style Characteristics

| Property | Value |
|---|---|
| Background | Soft ivory `#f7f2e8` |
| Text | Ink brown `#2b2622` |
| Accent | Vermilion `#b6492d` |
| Muted | Stone `#7c7268` |
| Tint | `rgba(182,73,45,0.06)` (panel backgrounds) |
| Title Font | `Noto Serif SC`, serif — weight 700/900 |
| Body Font | `Noto Sans SC`, sans-serif |
| Atmosphere | Quiet spacing, low ornament, single red gesture |
| Rules | 2px thin accent line with large margins |

## Template

<div style="max-width: 800px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 800px; }
    .card { position: relative; background: #f7f2e8; padding: 44px; overflow: hidden; font-family: 'Noto Sans SC', 'Inter', sans-serif; color: #2b2622; line-height: 1.68; }
    .card::before { content: ''; position: absolute; inset: 18px; border: 1px solid rgba(43,38,34,0.08); pointer-events: none; }
    .card-meta { margin: 0 0 16px; font-size: 11px; font-weight: 700; letter-spacing: 0.24em; text-transform: uppercase; color: #7c7268; }
    .card-title { margin: 0 0 18px; font-family: 'Noto Serif SC', serif; font-size: 38px; font-weight: 900; line-height: 1.18; letter-spacing: -0.03em; color: #2b2622; max-width: 540px; }
    .card-subtitle { margin: 0 0 18px; font-size: 16px; line-height: 1.7; color: #564d45; max-width: 560px; }
    .card-bar { width: 64px; height: 2px; margin: 0 0 24px; background: #b6492d; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.7; color: #2b2622; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.3fr 0.7fr; }
    .card-panel { padding: 16px 18px; background: rgba(182,73,45,0.06); border-left: 2px solid #b6492d; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #7c7268; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.65; color: #564d45; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; border: 1px solid rgba(182,73,45,0.2); color: #b6492d; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.06em; }
    .card-stat { font-family: 'Noto Serif SC', serif; font-size: 46px; font-weight: 700; line-height: 1; color: #b6492d; margin: 0; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #7c7268; text-transform: uppercase; letter-spacing: 0.14em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 900 70px/0.82 'Noto Serif SC', serif; float: left; margin: 4px 12px 0 -2px; color: #b6492d; }
    .card-highlight { font-size: 17px; font-weight: 500; line-height: 1.6; color: #2b2622; padding: 10px 0 10px 16px; border-left: 2px solid #b6492d; margin: 18px 0; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #2b2622; }
    .card-divider { height: 1px; background: rgba(43,38,34,0.08); margin: 22px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #b6492d; opacity: 0.45; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(43,38,34,0.08); font-size: 11px; color: #7c7268; letter-spacing: 0.05em; }
  </style>
  <div class="card">
    <p class="card-meta">Craft Note · Quiet Launch</p>
    <h1 class="card-title">A Slower Interface for a Faster Mind</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The product removes ornamental friction rather than adding more motion. Its interface is built around pause, legibility, and one decisive action per screen, so the user spends less time negotiating the chrome and more time thinking about the work itself.</p>
    <p class="card-highlight">Restraint becomes the visible feature</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel">
        <p class="card-panel-title">Design Principle</p>
        <p class="card-panel-text">Reduce every surface to one primary gesture, one line of context, and one durable visual anchor. Empty space is used as a decision boundary, not as decoration.</p>
      </div>
      <div>
        <p class="card-stat">3</p>
        <p class="card-stat-label">Core interactions</p>
      </div>
    </div>
    <span class="card-endmark">余白</span>
    <div class="card-footer">Studio Notes · Spring Collection 2026</div>
  </div>
</div>