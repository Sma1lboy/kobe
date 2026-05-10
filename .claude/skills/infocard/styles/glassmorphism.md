# Glassmorphism Style

**Style**: Frosted translucent panels over atmospheric gradients, soft glow accents, premium launch aesthetic
**Best for**: Product reveals, feature spotlights, event invitations, future-facing showcases, premium announcements

## Style Characteristics

| Property | Value |
|---|---|
| Background | Deep slate `#0d1726` with cyan-pink glow fields |
| Text | Mist white `#edf4ff` |
| Accent | Ice blue `#74d3ff` |
| Secondary | Coral glow `#ff8fb1` |
| Muted | Frost gray `#a9b6ca` |
| Surface | `rgba(255,255,255,0.12)` blur panels |
| Border | `1px solid rgba(255,255,255,0.22)` |
| Title Font | `Space Grotesk`, `Inter`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |

## Template

<div style="max-width: 840px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 840px; }
    .card { position: relative; background: radial-gradient(circle at 18% 18%, rgba(116,211,255,0.24), transparent 26%), radial-gradient(circle at 82% 22%, rgba(255,143,177,0.22), transparent 28%), linear-gradient(160deg, #0d1726 0%, #111d32 100%); padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #edf4ff; line-height: 1.6; border: 1px solid rgba(255,255,255,0.12); }
    .card::before { content: ''; position: absolute; inset: 0; pointer-events: none; backdrop-filter: blur(2px); background: linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0)); }
    .card-meta { position: relative; margin: 0 0 14px; font-size: 11px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: #a9b6ca; }
    .card-title { position: relative; margin: 0 0 16px; font-family: 'Space Grotesk', 'Inter', sans-serif; font-size: 38px; font-weight: 700; line-height: 1.1; letter-spacing: -0.03em; color: #edf4ff; max-width: 580px; }
    .card-subtitle { position: relative; margin: 0 0 16px; font-size: 16px; line-height: 1.62; color: #c9d6ea; max-width: 600px; }
    .card-bar { position: relative; width: 84px; height: 4px; margin: 0 0 22px; background: linear-gradient(90deg, #74d3ff 0%, #ff8fb1 100%); border-radius: 999px; }
    .card-body { position: relative; margin: 0 0 16px; font-size: 15px; line-height: 1.65; color: #edf4ff; }
    .card-grid { position: relative; display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.15fr 0.85fr; }
    .card-panel { padding: 16px 18px; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.22); box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 18px 40px rgba(3,10,20,0.25); backdrop-filter: blur(16px); border-radius: 20px; }
    .card-panel.heavy { background: rgba(255,255,255,0.16); }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #74d3ff; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.6; color: #d8e2f2; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 4px 10px; background: rgba(255,255,255,0.12); color: #edf4ff; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.05em; border-radius: 999px; border: 1px solid rgba(255,255,255,0.18); }
    .card-stat { font-family: 'Space Grotesk', 'Inter', sans-serif; font-size: 52px; font-weight: 700; line-height: 1; color: #edf4ff; margin: 0; text-shadow: 0 0 24px rgba(116,211,255,0.35); }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #a9b6ca; text-transform: uppercase; letter-spacing: 0.14em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 66px/0.82 'Space Grotesk', 'Inter', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #74d3ff; }
    .card-highlight { font-size: 17px; font-weight: 500; line-height: 1.5; color: #edf4ff; padding: 12px 16px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.1); border-radius: 16px; margin: 18px 0; display: inline-block; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #edf4ff; }
    .card-divider { height: 1px; background: rgba(255,255,255,0.14); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #74d3ff; opacity: 0.5; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.14); font-size: 11px; color: #a9b6ca; letter-spacing: 0.05em; }
  </style>
  <div class="card">
    <p class="card-meta">Feature Reveal · AI Workspace</p>
    <h1 class="card-title">Your Notes, Search, and Slides Now Share One Surface</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">Instead of jumping across disconnected tools, the new workspace layers capture, retrieval, and presentation into a single fluid loop. The interface keeps the context visible while the glass panels separate action, memory, and output with just enough depth.</p>
    <p class="card-highlight">One context stack, three modes of work</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel heavy">
        <p class="card-panel-title">Experience Layer</p>
        <p class="card-panel-text">Search, summarize, and present without changing mental mode. Each module stays visually distinct while sharing the same tonal field and information backbone.</p>
      </div>
      <div class="card-panel">
        <p class="card-stat">11s</p>
        <p class="card-stat-label">From idea to first deck draft</p>
      </div>
    </div>
    <span class="card-endmark">◌</span>
    <div class="card-footer">Product Preview · Vision Narrative 2026</div>
  </div>
</div>