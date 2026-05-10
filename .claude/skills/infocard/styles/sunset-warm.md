# Sunset Warm Style

**Style**: Warm gradient atmosphere, coral-amber accents, rounded panels, optimistic and inviting tone
**Best for**: Event notes, community recaps, lifestyle storytelling, warm announcements, celebration cards

## Style Characteristics

| Property | Value |
|---|---|
| Background | Warm gradient from peach to amber |
| Text | Walnut `#332421` |
| Accent | Coral `#d66b4d` |
| Secondary | Amber `#f2a23a` |
| Muted | Cocoa `#7a5a4f` |
| Surface | `rgba(255,255,255,0.46)` soft cards |
| Title Font | `Space Grotesk`, `Inter`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Mood | Rounded, positive, story-friendly |

## Template

<div style="max-width: 840px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 840px; }
    .card { position: relative; padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #332421; line-height: 1.64; }
    .card-surface-warm { background: radial-gradient(circle at 15% 15%, rgba(255,255,255,0.45), transparent 24%), linear-gradient(135deg, #ffd6b0 0%, #ffc493 34%, #f7b06c 68%, #f29d52 100%); border-radius: 28px; }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #7a5a4f; }
    .card-title { margin: 0 0 16px; font-family: 'Space Grotesk', 'Inter', sans-serif; font-size: 36px; font-weight: 700; line-height: 1.1; letter-spacing: -0.03em; color: #332421; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.62; color: #5c4039; max-width: 600px; }
    .card-bar { width: 84px; height: 6px; margin: 0 0 20px; background: linear-gradient(90deg, #d66b4d 0%, #f2a23a 100%); border-radius: 999px; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.68; color: #332421; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.1fr 0.9fr; }
    .card-panel { padding: 16px 18px; background: rgba(255,255,255,0.46); border: 1px solid rgba(255,255,255,0.34); border-radius: 18px; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #d66b4d; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.6; color: #5c4039; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 4px 9px; background: rgba(255,255,255,0.54); color: #d66b4d; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; border-radius: 999px; }
    .card-stat { font-family: 'Space Grotesk', 'Inter', sans-serif; font-size: 50px; font-weight: 700; line-height: 1; color: #d66b4d; margin: 0; }
    .card-accent-stat { color: #d66b4d; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #7a5a4f; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 64px/0.82 'Space Grotesk', 'Inter', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #d66b4d; }
    .card-highlight { font-size: 16px; font-weight: 600; line-height: 1.55; color: #332421; padding: 12px 14px; background: rgba(255,255,255,0.42); border-radius: 16px; margin: 16px 0; display: inline-block; }
    .card-highlight-soft { background: rgba(255,255,255,0.42); border-radius: 16px; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #332421; }
    .card-divider { height: 1px; background: rgba(51,36,33,0.12); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #d66b4d; opacity: 0.4; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(51,36,33,0.12); font-size: 11px; color: #7a5a4f; letter-spacing: 0.04em; }
  </style>
  <div class="card card-surface-warm">
    <p class="card-meta">Community Recap · Autumn Meetup</p>
    <h1 class="card-title">A Smaller Room, Better Conversations, Stronger Follow-Ups</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The meetup worked because it stayed human in scale. Instead of chasing attendance volume, the event prioritized dialogue, working demos, and follow-up threads that remained active after everyone went home.</p>
    <p class="card-highlight card-highlight-soft">Depth of conversation mattered more than headcount</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel">
        <p class="card-panel-title">What Landed</p>
        <p class="card-panel-text">Lightning talks stayed under seven minutes, demo tables stayed open late, and the closing circle surfaced concrete collaboration ideas instead of vague enthusiasm.</p>
      </div>
      <div class="card-panel">
        <p class="card-stat card-accent-stat">64</p>
        <p class="card-stat-label">Attendees, all sessions full</p>
      </div>
    </div>
    <span class="card-endmark">Sunset</span>
    <div class="card-footer">Field Notes · Local Creator Network</div>
  </div>
</div>