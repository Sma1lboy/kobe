# News Bulletin Layout

**Layout**: Headline-led bulletin with lead paragraph, ticker strip, and supporting mini-briefs
**Best for**: Breaking updates, digest summaries, morning briefs, release bulletins, status digests

## Template

<div style="max-width: 840px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fffdfa; padding: 40px; font-family: sans-serif; color: #181818; line-height: 1.6; border-left: 6px solid #181818; }
    .card-meta { margin: 0 0 10px; font-size: 12px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: #b42318; }
    .card-title { margin: 0 0 12px; font-size: 34px; font-weight: 800; line-height: 1.08; color: #181818; text-transform: uppercase; max-width: 620px; }
    .card-subtitle { margin: 0 0 16px; font-size: 15px; line-height: 1.58; color: #444; max-width: 620px; }
    .card-bar { width: 96px; height: 6px; margin: 0 0 18px; background: #b42318; }
    .card-ticker { padding: 10px 14px; background: rgba(180,35,24,0.06); border-top: 4px solid #b42318; font-size: 13px; font-weight: 700; color: #181818; margin-bottom: 14px; }
    .card-briefs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .card-brief { padding: 14px 16px; background: rgba(0,0,0,0.03); border-top: 4px solid #181818; }
    .card-brief-title { margin: 0 0 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #666; }
    .card-brief-text { margin: 0; font-size: 13px; line-height: 1.55; color: #444; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #777; }
  </style>
  <div class="card">
    <p class="card-meta">Daily Brief · 09:00</p>
    <h1 class="card-title">Platform Morning Bulletin</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Use this when one main update needs to anchor the card, while three smaller supporting developments help the reader build situational awareness quickly.</p>
    <div class="card-ticker">Lead: Export queue stabilized overnight after retry tuning reduced duplicate work across large image batches.</div>
    <div class="card-briefs">
      <div class="card-brief">
        <p class="card-brief-title">Infra</p>
        <p class="card-brief-text">No new alerts after memory cap adjustment in the preview worker pool.</p>
      </div>
      <div class="card-brief">
        <p class="card-brief-title">Product</p>
        <p class="card-brief-text">Infocard template expansion moved into review with four new layouts queued.</p>
      </div>
      <div class="card-brief">
        <p class="card-brief-title">Support</p>
        <p class="card-brief-text">Open ticket volume dropped after the export timeout copy was clarified.</p>
      </div>
    </div>
    <div class="card-footer">Ops Desk · Internal Distribution</div>
  </div>
</div>