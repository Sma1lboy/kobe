# Layered Sidebar Map Layout

**Layout**: Central layered stack flanked by narrow context rails on one or both sides
**Best for**: Enterprise architecture summaries, platform blueprints with horizontal threads (governance, KPIs, value chain) that need to frame the layered system without cluttering the stack itself

## Template

<div style="max-width: 960px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafafa; padding: 36px 40px; font-family: sans-serif; color: #111; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 28px; font-weight: 700; line-height: 1.2; color: #111; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 18px; background: #111; }
    .card-subtitle { margin: 0 0 22px; font-size: 14px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-map-wrap { display: grid; grid-template-columns: 160px 1fr 160px; gap: 12px; }
    .card-rail { display: flex; flex-direction: column; gap: 10px; }
    .card-rail-pnl { padding: 10px 11px; background: #ffffff; border: 1px solid rgba(0,0,0,0.08); border-left: 3px solid #111; }
    .card-rail-h { margin: 0 0 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #888; border-bottom: 1px solid rgba(0,0,0,0.08); padding-bottom: 4px; }
    .card-rail-i { font-size: 12px; line-height: 1.45; color: #333; padding: 4px 0; border-bottom: 1px dashed rgba(0,0,0,0.06); }
    .card-rail-i:last-child { border-bottom: none; }
    .card-rail-i.m { font-weight: 700; color: #111; }
    .card-stack { display: flex; flex-direction: column; gap: 8px; }
    .card-layer { padding: 12px 14px; background: rgba(0,0,0,0.03); border-top: 3px solid #111; }
    .card-layer.core { background: rgba(0,0,0,0.06); }
    .card-layer.muted { background: transparent; border-top: 2px dashed rgba(0,0,0,0.25); }
    .card-layer-h { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #111; }
    .card-layer-grid { display: grid; gap: 6px; }
    .card-layer-grid.g3 { grid-template-columns: repeat(3, 1fr); }
    .card-layer-grid.g4 { grid-template-columns: repeat(4, 1fr); }
    .card-layer-grid.g5 { grid-template-columns: repeat(5, 1fr); }
    .card-node { padding: 8px 7px; background: #ffffff; border: 1px solid rgba(0,0,0,0.08); font-size: 12px; font-weight: 600; color: #111; text-align: center; line-height: 1.35; }
    .card-node small { display: block; margin-top: 2px; font-size: 10px; font-weight: 400; color: #777; }
    .card-node.hl { background: rgba(0,0,0,0.08); border: 1.5px solid #111; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Platform Blueprint · Layered With Rails</p>
    <h1 class="card-title">Knowledge Platform Overview</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">The central stack answers how content flows top to bottom. The rails carry the threads that cut across every layer and usually get lost in a pure layered diagram.</p>
    <div class="card-map-wrap">
      <div class="card-rail">
        <div class="card-rail-pnl">
          <p class="card-rail-h">Value Chain</p>
          <div class="card-rail-i">Capture</div>
          <div class="card-rail-i">Curate</div>
          <div class="card-rail-i">Compose</div>
          <div class="card-rail-i">Distribute</div>
        </div>
        <div class="card-rail-pnl">
          <p class="card-rail-h">Surfaces</p>
          <div class="card-rail-i m">Web reader</div>
          <div class="card-rail-i m">Editor host</div>
          <div class="card-rail-i">Export bundle</div>
        </div>
      </div>
      <div class="card-stack">
        <div class="card-layer">
          <p class="card-layer-h">Experience Layer</p>
          <div class="card-layer-grid g4">
            <div class="card-node">Reader shell<small>Progressive layout</small></div>
            <div class="card-node">Authoring pane<small>Live preview</small></div>
            <div class="card-node hl">Command surface<small>Skill bindings</small></div>
            <div class="card-node">Export view<small>Print · share</small></div>
          </div>
        </div>
        <div class="card-layer core">
          <p class="card-layer-h">Processing Core</p>
          <div class="card-layer-grid g3">
            <div class="card-node hl">Parser pipeline<small>AST · plugins</small></div>
            <div class="card-node hl">Render engine<small>Themes · targets</small></div>
            <div class="card-node">Skill runtime<small>Prompt adapters</small></div>
          </div>
        </div>
        <div class="card-layer">
          <p class="card-layer-h">Data Layer</p>
          <div class="card-layer-grid g4">
            <div class="card-node">Document store</div>
            <div class="card-node">Asset cache</div>
            <div class="card-node">Memory graph</div>
            <div class="card-node">Audit log</div>
          </div>
        </div>
        <div class="card-layer muted">
          <p class="card-layer-h">External Services (bounded)</p>
          <div class="card-layer-grid g3">
            <div class="card-node">Model providers</div>
            <div class="card-node">Search index</div>
            <div class="card-node">Sync endpoints</div>
          </div>
        </div>
      </div>
      <div class="card-rail">
        <div class="card-rail-pnl">
          <p class="card-rail-h">Cross-Cut Threads</p>
          <div class="card-rail-i">Access policy</div>
          <div class="card-rail-i">Content provenance</div>
          <div class="card-rail-i">Observability</div>
          <div class="card-rail-i">Rate limits</div>
        </div>
        <div class="card-rail-pnl">
          <p class="card-rail-h">North-Star Signals</p>
          <div class="card-rail-i m">Time to first render</div>
          <div class="card-rail-i m">Render error rate</div>
          <div class="card-rail-i m">Weekly active authors</div>
        </div>
      </div>
    </div>
    <div class="card-footer">Architecture Reference · Internal</div>
  </div>
</div>

## Variations

- **Single rail**: drop one side and switch the outer grid to `200px 1fr`. Useful when only one family of cross-cut threads matters.
- **Muted external tier**: keep the bottom `muted` layer dashed to signal "bounded / third-party", so it does not visually compete with owned layers.
- **Row emphasis**: promote one layer with the `core` modifier. Only one layer should carry it — the one that holds the platform's main value.

## When Not to Use

- The content is a flat list of capabilities → use `badge-grid`.
- The system has no clear top-to-bottom flow → use `radial-hub` or `architecture-map`.
- The rails repeat the same items as the stack → drop the rails; the layout is noise without them.
