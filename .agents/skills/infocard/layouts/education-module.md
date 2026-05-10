# Education Module Layout

**Layout**: Lesson card with objective, key ideas, activity, and takeaway blocks
**Best for**: Lesson summaries, workshop modules, learning paths, class notes, teaching cards

## Template

<div style="max-width: 860px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafaf8; padding: 40px; font-family: sans-serif; color: #171717; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #171717; }
    .card-subtitle { margin: 0 0 18px; font-size: 15px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #171717; }
    .card-doc { display: grid; gap: 14px; }
    .card-section { padding: 16px 18px; background: rgba(0,0,0,0.03); border-left: 4px solid #171717; }
    .card-section-title { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #666; }
    .card-section-text { margin: 0; font-size: 14px; line-height: 1.6; color: #444; }
    .card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .card-doc-list { list-style: none; margin: 0; padding: 0; }
    .card-doc-list li { position: relative; padding-left: 16px; margin-bottom: 8px; font-size: 13px; line-height: 1.55; color: #444; }
    .card-doc-list li:last-child { margin-bottom: 0; }
    .card-doc-list.bullet li::before { content: '•'; position: absolute; left: 0; color: #171717; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Learning Design · Module Card</p>
    <h1 class="card-title">Teaching System Thinking Through One Simple Flow</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Use this layout when a lesson needs to be compact, teachable, and easy to scan by instructors or learners.</p>
    <div class="card-doc">
      <div class="card-section">
        <p class="card-section-title">Objective</p>
        <p class="card-section-text">Help learners identify feedback loops, bottlenecks, and visible symptoms inside a simple multi-step system.</p>
      </div>
      <div class="card-grid">
        <div class="card-section">
          <p class="card-section-title">Key Ideas</p>
          <ul class="card-doc-list bullet">
            <li>Symptoms are not always causes.</li>
            <li>Constraints often move, not disappear.</li>
            <li>Structure influences behavior.</li>
          </ul>
        </div>
        <div class="card-section">
          <p class="card-section-title">Activity</p>
          <p class="card-section-text">Ask students to map a familiar workflow, mark delays, then explain which delay is causal and which is merely visible.</p>
        </div>
      </div>
      <div class="card-section">
        <p class="card-section-title">Takeaway</p>
        <p class="card-section-text">Good diagnosis starts when learners stop treating every visible problem as the root problem.</p>
      </div>
    </div>
    <div class="card-footer">Course Design · Session Handout</div>
  </div>
</div>