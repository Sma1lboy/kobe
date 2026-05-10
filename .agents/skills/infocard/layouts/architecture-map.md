# Architecture Map Layout

**Layout**: Layered system diagram with a dominant core tier, supporting service bands, and a narrow operations strip
**Best for**: Platform overviews, service boundaries, technical blueprints, API ecosystems, stack explanations

## Template

<div style="max-width: 860px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafafa; padding: 40px; font-family: sans-serif; color: #111; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #111; }
    .card-subtitle { margin: 0 0 20px; font-size: 15px; line-height: 1.55; color: #444; max-width: 620px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #111; }
    .card-map { display: grid; gap: 12px; }
    .card-map-zone { padding: 16px 18px; background: rgba(0,0,0,0.03); border-top: 4px solid #111; }
    .card-map-zone.core { background: rgba(0,0,0,0.06); }
    .card-map-zone.ops { display: grid; grid-template-columns: 1.1fr 0.9fr 0.9fr; gap: 12px; background: transparent; border-top: none; padding: 0; }
    .card-map-zone-title { margin: 0 0 10px; font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #888; }
    .card-map-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .card-map-node { padding: 14px; background: #ffffff; border: 1px solid rgba(0,0,0,0.08); }
    .card-node-title { margin: 0 0 4px; font-size: 14px; font-weight: 700; color: #111; }
    .card-node-text { margin: 0; font-size: 13px; line-height: 1.55; color: #555; }
    .card-map-zone.ops .card-map-node { border-top: 4px solid #111; }
    .card-footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">System Overview · Layered Stack</p>
    <h1 class="card-title">Markdown Rendering Platform</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Each tier should answer a different question: where content enters, how it is transformed, and which delivery surfaces finally expose it to users.</p>
    <div class="card-map">
      <div class="card-map-zone">
        <p class="card-map-zone-title">Input Layer</p>
        <div class="card-map-grid">
          <div class="card-map-node"><p class="card-node-title">Markdown Sources</p><p class="card-node-text">Files, clipboard payloads, generated prompts, synced docs.</p></div>
          <div class="card-map-node"><p class="card-node-title">Embedded Media</p><p class="card-node-text">Mermaid, Vega, HTML snippets, canvas assets, images.</p></div>
          <div class="card-map-node"><p class="card-node-title">Skill Packs</p><p class="card-node-text">Task-specific instructions that bias transformation and output structure.</p></div>
        </div>
      </div>
      <div class="card-map-zone core">
        <p class="card-map-zone-title">Core Processing</p>
        <div class="card-map-grid">
          <div class="card-map-node"><p class="card-node-title">Parser Pipeline</p><p class="card-node-text">AST normalization, plugin hooks, markdown feature expansion.</p></div>
          <div class="card-map-node"><p class="card-node-title">Renderer Layer</p><p class="card-node-text">HTML generation, theme application, export-specific transforms.</p></div>
          <div class="card-map-node"><p class="card-node-title">Messaging Bridge</p><p class="card-node-text">Host communication across browser, mobile, and editor surfaces.</p></div>
        </div>
      </div>
      <div class="card-map-zone ops">
        <div class="card-map-node"><p class="card-node-title">Observability</p><p class="card-node-text">Error capture, cache diagnostics, performance traces.</p></div>
        <div class="card-map-node"><p class="card-node-title">Exporters</p><p class="card-node-text">Word output, image capture, share bundles.</p></div>
        <div class="card-map-node"><p class="card-node-title">Clients</p><p class="card-node-text">VS Code, browsers, mobile shells, Obsidian.</p></div>
      </div>
    </div>
    <div class="card-footer">Platform Map · Internal Reference</div>
  </div>
</div>