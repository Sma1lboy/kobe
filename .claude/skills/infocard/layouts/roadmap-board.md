# Roadmap Board Layout

**Layout**: Four-phase planning board with one dominant near-term column and lighter downstream stages
**Best for**: Product sequencing, strategic plans, phased rollouts, quarterly priorities, capability roadmaps

## Template

<div style="max-width: 860px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafaf8; padding: 40px; font-family: sans-serif; color: #171717; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #171717; }
    .card-subtitle { margin: 0 0 20px; font-size: 15px; line-height: 1.55; color: #4f4f4f; max-width: 620px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #171717; }
    .card-sequence { display: grid; grid-template-columns: 1.2fr 1fr 1fr 0.9fr; gap: 14px; }
    .card-sequence-stage { padding: 18px; background: rgba(0,0,0,0.03); border-top: 4px solid #171717; min-height: 220px; }
    .card-sequence-stage.primary { background: rgba(0,0,0,0.06); }
    .card-sequence-label { margin: 0 0 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #888; }
    .card-sequence-title { margin: 0 0 12px; font-size: 18px; font-weight: 700; color: #171717; }
    .card-sequence-list { list-style: none; margin: 0; padding: 0; }
    .card-sequence-list li { position: relative; padding-left: 16px; margin-bottom: 8px; font-size: 13px; line-height: 1.55; color: #4f4f4f; }
    .card-sequence-list li:last-child { margin-bottom: 0; }
    .card-sequence-list.bullet li::before { content: ''; position: absolute; left: 0; top: 8px; width: 7px; height: 7px; border-radius: 50%; background: #171717; }
    .card-sequence-tag { display: inline-block; margin-top: 14px; padding: 3px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; background: #171717; color: #fafaf8; }
    .card-footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Strategy · 4-Phase Plan</p>
    <h1 class="card-title">AI Workspace Roadmap</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Near-term work owns the most surface area. Later phases stay intentionally lighter to signal confidence bands rather than fake precision.</p>
    <div class="card-sequence">
      <div class="card-sequence-stage primary">
        <p class="card-sequence-label">Now</p>
        <p class="card-sequence-title">Foundation Cleanup</p>
        <ul class="card-sequence-list bullet">
          <li>Unify renderer cache keys</li>
          <li>Stabilize export pipeline</li>
          <li>Reduce startup bundle drift</li>
        </ul>
        <span class="card-sequence-tag">Execution</span>
      </div>
      <div class="card-sequence-stage">
        <p class="card-sequence-label">Next</p>
        <p class="card-sequence-title">Authoring Speed</p>
        <ul class="card-sequence-list bullet">
          <li>Prompt-aware starter templates</li>
          <li>Richer inline preview actions</li>
          <li>Preset card styles per scenario</li>
        </ul>
      </div>
      <div class="card-sequence-stage">
        <p class="card-sequence-label">Later</p>
        <p class="card-sequence-title">Publishing Layer</p>
        <ul class="card-sequence-list bullet">
          <li>Presentation packaging</li>
          <li>Shareable static bundles</li>
          <li>Cross-device sync hooks</li>
        </ul>
      </div>
      <div class="card-sequence-stage">
        <p class="card-sequence-label">Vision</p>
        <p class="card-sequence-title">Multimodal Studio</p>
        <ul class="card-sequence-list bullet">
          <li>Slides, docs, and canvases as one graph</li>
          <li>Searchable memory-backed authoring</li>
        </ul>
      </div>
    </div>
    <div class="card-footer">Roadmap · Updated Q2 2026</div>
  </div>
</div>