# Terminal Green Style

**Style**: Retro phosphor screen, monochrome green text, monospace structure, low-noise operational mood
**Best for**: Infra status cards, CLI how-tos, incident logs, security notes, retro-computing topics

## Style Characteristics

| Property | Value |
|---|---|
| Background | Near-black `#07110a` |
| Text | Phosphor green `#9dff9d` |
| Accent | Bright mint `#43f08f` |
| Muted | Moss `#4e8b62` |
| Tint | `rgba(67,240,143,0.08)` (panel backgrounds) |
| Title Font | `IBM Plex Mono`, `SF Mono`, monospace |
| Body Font | `IBM Plex Mono`, `SF Mono`, monospace |
| Screen Effect | Soft vignette with scanline overlay |
| Rules | 1px terminal separators |

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card-frame { max-width: 820px; }
    .card { position: relative; background: #07110a; padding: 38px; overflow: hidden; font-family: 'IBM Plex Mono', 'SF Mono', monospace; color: #9dff9d; line-height: 1.66; border: 1px solid rgba(67,240,143,0.22); box-shadow: inset 0 0 80px rgba(67,240,143,0.04); }
    .card-surface-scanlines::before { content: ''; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(to bottom, rgba(255,255,255,0.03) 0, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 4px); background-size: 100% 4px; opacity: 0.12; }
    .card-text-mono { font-family: 'IBM Plex Mono', 'SF Mono', monospace; }
    .card-meta { margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #4e8b62; }
    .card-title { margin: 0 0 16px; font-size: 32px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; color: #43f08f; text-shadow: 0 0 12px rgba(67,240,143,0.18); }
    .card-subtitle { margin: 0 0 16px; font-size: 15px; line-height: 1.65; color: #88d999; }
    .card-bar { width: 96px; height: 1px; margin: 0 0 20px; background: #43f08f; box-shadow: 0 0 12px rgba(67,240,143,0.25); }
    .card-body { margin: 0 0 16px; font-size: 14px; line-height: 1.68; color: #9dff9d; }
    .card-grid { display: grid; gap: 14px; }.card-grid-2 { grid-template-columns: 1.15fr 0.85fr; }
    .card-panel { padding: 14px 16px; background: rgba(67,240,143,0.08); border: 1px solid rgba(67,240,143,0.18); }
    .card-panel-title { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #43f08f; }
    .card-panel-text { margin: 0; font-size: 13px; line-height: 1.62; color: #88d999; }
    .card-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 8px; background: rgba(67,240,143,0.1); color: #43f08f; margin-right: 6px; margin-bottom: 4px; letter-spacing: 0.04em; border: 1px solid rgba(67,240,143,0.2); }
    .card-stat { font-size: 46px; font-weight: 700; line-height: 1; color: #43f08f; margin: 0; text-shadow: 0 0 12px rgba(67,240,143,0.25); }
    .card-stat-label { font-size: 11px; font-weight: 700; color: #4e8b62; text-transform: uppercase; letter-spacing: 0.12em; margin: 6px 0 0; }
    .card-body.dropcap::first-letter { font: 700 62px/0.82 'IBM Plex Mono', monospace; float: left; margin: 4px 12px 0 -2px; color: #43f08f; }
    .card-highlight { font-size: 15px; font-weight: 500; line-height: 1.55; color: #9dff9d; padding: 10px 12px; border: 1px solid rgba(67,240,143,0.22); background: rgba(67,240,143,0.06); margin: 16px 0; }
    .card-item { margin-bottom: 12px; }.card-item:last-child { margin-bottom: 0; }
    .card-item-label { margin: 0 0 4px; font-size: 14px; font-weight: 700; color: #43f08f; }
    .card-divider { height: 1px; background: rgba(67,240,143,0.14); margin: 18px 0; }
    .card-endmark { display: block; text-align: right; font-size: 13px; color: #43f08f; opacity: 0.5; margin-top: 18px; }
    .card-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(67,240,143,0.14); font-size: 11px; color: #4e8b62; letter-spacing: 0.04em; }
  </style>
  <div class="card card-surface-scanlines">
    <p class="card-meta card-text-mono">ops://incident-3472</p>
    <h1 class="card-title">Queue Recovery Completed Without Data Loss</h1>
    <div class="card-bar"></div>
    <p class="card-body dropcap">A burst of malformed retry messages caused consumer lag to spike across two partitions at 03:14 UTC. The mitigation path isolated the offending producer, drained the dead-letter queue, and replayed validated events through a throttled recovery lane.</p>
    <p class="card-highlight">status=resolved · replay=100% · loss=0 records</p>
    <div class="card-grid card-grid-2">
      <div class="card-panel">
        <p class="card-panel-title card-text-mono">Mitigation Path</p>
        <p class="card-panel-text">producer quarantine -> schema patch -> DLQ replay -> lag normalization -> alert closure</p>
      </div>
      <div class="card-panel">
        <p class="card-stat card-text-mono">17m</p>
        <p class="card-stat-label card-text-mono">Total recovery time</p>
      </div>
    </div>
    <span class="card-endmark">$ exit 0</span>
    <div class="card-footer card-text-mono">SRE Postmortem Snapshot · Apr 2026</div>
  </div>
</div>