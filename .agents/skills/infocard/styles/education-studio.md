# Education Studio Style

**Style**: Warm instructional surface, classroom blue accents, approachable hierarchy for teaching
**Best for**: Teaching notes, course modules, learning summaries, workshop guides, study materials

## Style Characteristics

| Property | Value |
|---|---|
| Background | Classroom ivory `#f8f6f1` |
| Text | Lesson charcoal `#2a2a28` |
| Accent | Learning blue `#3a6fb0` |
| Secondary | Chalk teal `#4b8b84` |
| Muted | Note gray `#7c7c76` |
| Tint | `rgba(58,111,176,0.06)` |
| Title Font | `Space Grotesk`, `Inter`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |
| Surface | Clear, supportive, tutorial-friendly |

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; padding: 40px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #2a2a28; line-height: 1.68; }
    .card-surface-soft { background: #f8f6f1; }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #7c7c76; }
    .card-title { margin: 0 0 16px; font-family: 'Space Grotesk', 'Inter', sans-serif; font-size: 36px; font-weight: 700; line-height: 1.1; letter-spacing: -0.03em; color: #2a2a28; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.64; color: #5c5b57; }
    .card-bar { width: 80px; height: 5px; margin: 0 0 20px; background: #3a6fb0; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.7; color: #3f3f3b; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.15fr 0.85fr; }
    .card-panel { padding: 16px 18px; background: rgba(58,111,176,0.06); }
    .card-accent-panel-left { border-left: 4px solid #3a6fb0; }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #4b8b84; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.62; color: #5c5b57; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: rgba(58,111,176,0.1); color: #3a6fb0; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; }
    .card-stat { font-size: 48px; font-weight: 700; line-height: 1; color: #3a6fb0; margin: 0; }
    .card-accent-stat { color: #3a6fb0; }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #7c7c76; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 66px/0.82 'Space Grotesk', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #3a6fb0; }
    .card-highlight { font-size: 16px; font-weight: 600; line-height: 1.56; color: #2a2a28; padding: 10px 0 10px 16px; margin: 16px 0; }
    .card-accent-highlight-left { border-left: 3px solid #3a6fb0; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #2a2a28; }
    .card-divider { height: 1px; background: rgba(42,42,40,0.1); margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #3a6fb0; opacity: 0.35; margin-top: 20px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(42,42,40,0.1); font-size: 11px; color: #7c7c76; letter-spacing: 0.04em; }
  </style>
  <div class="card card-surface-soft">
    <p class="card-meta">Learning Module · Week 3</p>
    <h1 class="card-title">Students Understand Faster When the Pattern Is Visible Early</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">The lesson improved when the framework appeared before the examples. Once learners could see the structure first, they treated the examples as evidence instead of isolated facts to memorize.</p>
    <p class="card-highlight card-accent-highlight-left">Teach the shape before the details</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel card-accent-panel-left">
        <p class="card-panel-title">Teaching Move</p>
        <p class="card-panel-text">Open with one concept map, then attach cases, exercises, and discussion prompts to that map rather than presenting them as a flat sequence.</p>
      </div>
      <div class="card-panel card-accent-panel-left">
        <p class="card-stat card-accent-stat">3</p>
        <p class="card-stat-label">Core ideas in this lesson</p>
      </div>
    </div>
    <span class="card-endmark">LEARN</span>
    <div class="card-footer">Workshop Notes · Instructor Edition</div>
  </div>
</div>