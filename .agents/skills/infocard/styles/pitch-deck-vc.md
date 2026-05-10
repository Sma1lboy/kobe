# Pitch Deck VC Style

**Style**: Clean fundraising card, generous whitespace, strong thesis headline, blue-violet highlight
**Best for**: Fundraising snapshots, startup traction cards, market opportunity framing, investor updates

## Style Characteristics

| Property | Value |
|---|---|
| Background | White `#fdfdff` |
| Text | Dark charcoal `#16181d` |
| Accent | Blue-violet `#5865f2` |
| Secondary | Soft indigo `#7380f7` |
| Muted | Deal memo gray `#6b7280` |
| Tint | `rgba(88,101,242,0.06)` |
| Title Font | `Inter`, `Space Grotesk`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Surface | YC-like whitespace and hard thesis framing |

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; background: #fdfdff; padding: 42px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #16181d; line-height: 1.64; border: 1px solid rgba(22,24,29,0.07); }
    .card-surface-clean { border: 1px solid rgba(22,24,29,0.07); }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #5865f2; }
    .card-title { margin: 0 0 16px; font-family: 'Space Grotesk', 'Inter', sans-serif; font-size: 38px; font-weight: 700; line-height: 1.08; letter-spacing: -0.03em; color: #16181d; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.62; color: #4b5563; max-width: 620px; }
    .card-bar { width: 74px; height: 4px; margin: 0 0 22px; background: #5865f2; border-radius: 999px; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.66; color: #2f3540; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.15fr 0.85fr; }
    .card-panel { padding: 16px 18px; background: rgba(88,101,242,0.06); border-left: 4px solid #5865f2; }
    .card-accent-panel-left { border-left: 4px solid #5865f2; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #5865f2; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.58; color: #4b5563; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: rgba(88,101,242,0.1); color: #5865f2; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; }
    .card-stat { font-family: 'Space Grotesk', 'Inter', sans-serif; font-size: 52px; font-weight: 700; line-height: 1; color: #5865f2; margin: 0; }
    .card-accent-stat { color: #5865f2; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 66px/0.82 'Space Grotesk', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #5865f2; }
    .card-highlight { font-size: 16px; font-weight: 600; line-height: 1.55; color: #16181d; padding: 10px 0 10px 16px; border-left: 3px solid #5865f2; margin: 16px 0; }
    .card-accent-highlight-left { border-left: 3px solid #5865f2; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #16181d; }
    .card-divider { height: 1px; background: rgba(22,24,29,0.08); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #5865f2; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(22,24,29,0.08); font-size: 11px; color: #6b7280; letter-spacing: 0.04em; }
  </style>
  <div class="card card-surface-clean">
    <p class="card-meta">Seed Update · Investor Snapshot</p>
    <h1 class="card-title">The Product Replaced Three Workflows, Not Just One Feature</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The strongest signal in the last six months was not raw signup count. It was workflow consolidation. Teams that adopted the product reduced tool switching and embedded it into planning, review, and publishing rather than using it as a narrow utility.</p>
    <p class="card-highlight card-accent-highlight-left">Retention rose as the product became infrastructure, not just software</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel card-accent-panel-left">
        <p class="card-panel-title">Why Now</p>
        <p class="card-panel-text">AI content generation increased output volume, but teams still lack a clear surface for refining, presenting, and sharing that work with structure.</p>
      </div>
      <div class="card-panel card-accent-panel-left">
        <p class="card-stat card-accent-stat">3.4x</p>
        <p class="card-stat-label">Expansion revenue growth</p>
      </div>
    </div>
    <span class="card-endmark">DEAL</span>
    <div class="card-footer">Fundraising Memo · Draft Excerpt</div>
  </div>
</div>