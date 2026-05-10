# Neo Brutalism Style

**Style**: Flat saturated blocks, thick outlines, hard shadows, oversized typography, confrontational clarity
**Best for**: Manifestos, bold product launches, campaign cards, startup narratives, punchy takeaways

## Style Characteristics

| Property | Value |
|---|---|
| Background | Warm cream `#fff7e8` |
| Text | Charcoal `#1f1b18` |
| Accent | Electric orange `#ff7a00` |
| Secondary | Acid yellow `#ffe66d` |
| Muted | Cocoa `#6b5f57` |
| Border | 3px solid charcoal |
| Shadow | Hard offset `8px 8px 0 #1f1b18` |
| Title Font | `Archivo Black`, `Inter`, sans-serif |
| Body Font | `Inter`, `Noto Sans SC`, sans-serif |

## Template

<div style="max-width: 800px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 800px; }
    .card { position: relative; background: #fff7e8; padding: 36px; overflow: hidden; font-family: 'Inter', 'Noto Sans SC', sans-serif; color: #1f1b18; line-height: 1.6; border: 3px solid #1f1b18; box-shadow: 8px 8px 0 #1f1b18; }
    .card-meta { display: inline-block; margin: 0 0 14px; font-size: 11px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: #1f1b18; background: #ffe66d; padding: 6px 10px; border: 3px solid #1f1b18; }
    .card-title { margin: 0 0 16px; font-family: 'Archivo Black', 'Inter', sans-serif; font-size: 38px; font-weight: 900; line-height: 1.02; letter-spacing: -0.03em; color: #1f1b18; max-width: 580px; }
    .card-subtitle { margin: 0 0 16px; font-size: 16px; line-height: 1.58; color: #3d352f; }
    .card-bar { width: 92px; height: 8px; margin: 0 0 20px; background: #ff7a00; border: 3px solid #1f1b18; }
    .card-body { margin: 0 0 16px; font-size: 15px; line-height: 1.62; color: #1f1b18; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.2fr 0.8fr; }
    .card-panel { padding: 16px 18px; background: #ffffff; border: 3px solid #1f1b18; box-shadow: 6px 6px 0 #ffe66d; }
    .card-panel.heavy { background: #ff7a00; color: #1f1b18; box-shadow: 6px 6px 0 #1f1b18; }
    .card-panel-title { margin: 0 0 8px; font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: inherit; }
    .card-panel-text { margin: 0; font-size: 14px; line-height: 1.55; color: inherit; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 800; padding: 4px 8px; background: #ffffff; color: #1f1b18; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; border: 2px solid #1f1b18; }
    .card-stat { font-family: 'Archivo Black', 'Inter', sans-serif; font-size: 54px; font-weight: 900; line-height: 0.95; color: #ff7a00; margin: 0; -webkit-text-stroke: 2px #1f1b18; }
    .card-accent-stat { color: #ff7a00; }
    .card-stat-label { font-size: 11px; font-weight: 800; color: #6b5f57; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 900 68px/0.82 'Archivo Black', 'Inter', sans-serif; float: left; margin: 4px 12px 0 -2px; color: #ff7a00; }
    .card-highlight { font-size: 17px; font-weight: 700; line-height: 1.45; color: #1f1b18; padding: 10px 14px; background: #ffe66d; border: 3px solid #1f1b18; margin: 16px 0; display: inline-block; }
    .card-highlight-boxed { background: #ffe66d; border: 3px solid #1f1b18; }
    .card-item { margin-bottom: 14px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 15px; font-weight: 800; color: #1f1b18; }
    .card-divider { height: 3px; background: #1f1b18; margin: 20px 0; }
    .card-endmark { display: block; text-align: right; font-size: 14px; color: #1f1b18; opacity: 0.5; margin-top: 18px; font-weight: 800; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 3px solid #1f1b18; font-size: 11px; color: #6b5f57; letter-spacing: 0.05em; font-weight: 700; }
  </style>
  <div class="card">
    <p class="card-meta">Launch Memo · Statement</p>
    <h1 class="card-title">Stop Shipping Average Product Pages</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">Most launch pages fail before the reader reaches the second scroll. They stack generic claims in identical boxes, dilute urgency with vague adjectives, and hide the actual promise beneath ornamental gradients. Clarity should hit first, not fifth.</p>
    <p class="card-highlight card-highlight-boxed">Make one claim. Prove it loudly.</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel heavy">
        <p class="card-panel-title">What Changed</p>
        <p class="card-panel-text">We reduced the message to one sentence, one metric, and one proof block. Every other element now exists to support that line instead of competing with it.</p>
      </div>
      <div class="card-panel">
        <p class="card-stat card-accent-stat">42%</p>
        <p class="card-stat-label">Higher click-through after rewrite</p>
      </div>
    </div>
    <span class="card-endmark">NO FLUFF</span>
    <div class="card-footer">Growth Team · Launch Retrospective</div>
  </div>
</div>