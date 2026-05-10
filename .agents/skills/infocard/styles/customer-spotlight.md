# Customer Spotlight Style

**Style**: Warm neutral case-study tone, human-centric contrast, outcome-led storytelling
**Best for**: Customer stories, success recaps, case studies, user adoption highlights, partner narratives, brand stories, narrative recaps

## Style Characteristics

| Property | Value |
|---|---|
| Background | Soft sand `#f7f3ed` |
| Text | Warm charcoal `#2e2925` |
| Accent | Burnt orange `#b8663d` |
| Secondary | Clay `#6d5d52` |
| Muted | Dust `#8b7c72` |
| Tint | `rgba(184,102,61,0.06)` |
| Title Font | `Space Grotesk`, `Noto Serif SC`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Surface | Editorial case-study warmth |

## Merge Note

This style now absorbs the previous role of `retro-vintage`.

- `retro-vintage` and `customer-spotlight` overlapped on warm narrative storytelling, sepia-adjacent palettes, and editorial card rhythm.
- `customer-spotlight` is kept as the canonical file because it handles a wider modern storytelling range while still fitting historical and retrospective summaries.

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #2e2925; line-height: 1.66; }
    .card-surface-warm { background: #f7f3ed; }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #8b7c72; }
    .card-title { margin: 0 0 16px; font-family: 'Space Grotesk', 'Noto Serif SC', sans-serif; font-size: 36px; font-weight: 700; line-height: 1.1; letter-spacing: -0.03em; color: #2e2925; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.62; color: #6d5d52; }
    .card-bar { width: 76px; height: 5px; margin: 0 0 20px; background: #b8663d; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.7; color: #443c36; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.15fr 0.85fr; }
    .card-panel { padding: 16px 18px; background: rgba(184,102,61,0.06); }
    .card-accent-panel-left { border-left: 4px solid #b8663d; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #b8663d; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.6; color: #6d5d52; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: rgba(184,102,61,0.1); color: #b8663d; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; }
    .card-stat { font-size: 48px; font-weight: 700; line-height: 1; color: #b8663d; margin: 0; }
    .card-accent-stat { color: #b8663d; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #8b7c72; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 66px/0.82 'Space Grotesk', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #b8663d; }
    .card-highlight { font-size: 16px; font-weight: 600; line-height: 1.55; color: #2e2925; padding: 10px 0 10px 16px; margin: 16px 0; }
    .card-accent-highlight-left { border-left: 3px solid #b8663d; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #2e2925; }
    .card-divider { height: 1px; background: rgba(46,41,37,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #b8663d; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(46,41,37,0.1); font-size: 11px; color: #8b7c72; letter-spacing: 0.04em; }
  </style>
  <div class="card card-surface-warm">
    <p class="card-meta">Customer Story · Adoption Note</p>
    <h1 class="card-title">The Team Stopped Rebuilding the Same Deck Every Week</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The customer's workflow problem was not a lack of content. It was repetitive reconstruction. Once a shared template system replaced manual formatting, the team shifted effort from reassembly into review and interpretation.</p>
    <p class="card-highlight card-accent-highlight-left">Reuse improved quality because it reduced avoidable rework</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel card-accent-panel-left">
        <p class="card-panel-title">Before vs After</p>
        <p class="card-panel-text">Weekly reports moved from scattered note fragments and slide duplication toward one authoring path with stable visual defaults and faster stakeholder review.</p>
      </div>
      <div class="card-panel card-accent-panel-left">
        <p class="card-stat card-accent-stat">6h</p>
        <p class="card-stat-label">Saved per weekly cycle</p>
      </div>
    </div>
    <span class="card-endmark">STORY</span>
    <div class="card-footer">Customer Success · Case Snapshot</div>
  </div>
</div>