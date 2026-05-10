# Pros & Cons Layout

**Layout**: Two weighted evaluation panels with a bottom synthesis block for the actual decision logic
**Best for**: Trade-off analysis, risk assessment, decision framing, option selection, product evaluation

## Template

<div style="max-width: 820px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafafa; padding: 40px; font-family: sans-serif; color: #111; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #111; }
    .card-subtitle { margin: 0 0 20px; font-size: 15px; line-height: 1.55; color: #444; max-width: 620px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #111; }
    .card-compare { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 14px; }
    .card-compare-side { padding: 18px; border-top: 4px solid #111; }
    .card-compare-side.pros { background: rgba(0,0,0,0.03); }
    .card-compare-side.cons { background: rgba(0,0,0,0.06); }
    .card-compare-label { margin: 0 0 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #888; }
    .card-compare-title { margin: 0 0 10px; font-size: 18px; font-weight: 700; color: #111; }
    .card-compare-list { list-style: none; margin: 0; padding: 0; }
    .card-compare-list li { position: relative; padding-left: 18px; margin-bottom: 10px; font-size: 13px; line-height: 1.55; color: #444; }
    .card-compare-list li:last-child { margin-bottom: 0; }
    .card-compare-list li::before { position: absolute; left: 0; top: 0; font-weight: 700; color: #111; }
    .card-compare-side.pros .card-compare-list li::before { content: '+'; }
    .card-compare-side.cons .card-compare-list li::before { content: '-'; }
    .card-compare-summary { margin-top: 14px; padding: 18px; background: rgba(0,0,0,0.03); border-left: 4px solid #111; }
    .card-compare-summary-title { margin: 0 0 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #888; }
    .card-compare-summary-text { margin: 0; font-size: 14px; line-height: 1.6; color: #444; }
    .card-footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Decision Memo · Trade-Off</p>
    <h1 class="card-title">Should We Move to a Plugin-First Architecture?</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">The goal is not to score both sides evenly. The goal is to make the dependency, maintenance, and ecosystem trade-offs visible enough to support a decision.</p>
    <div class="card-compare">
      <div class="card-compare-side pros">
        <p class="card-compare-label">Upside</p>
        <p class="card-compare-title">Why It Helps</p>
        <ul class="card-compare-list">
          <li>Feature velocity improves when extensions ship independently.</li>
          <li>Core code stays smaller and easier to reason about.</li>
          <li>Community contributions get a cleaner boundary.</li>
        </ul>
      </div>
      <div class="card-compare-side cons">
        <p class="card-compare-label">Risk</p>
        <p class="card-compare-title">What It Costs</p>
        <ul class="card-compare-list">
          <li>Public APIs harden earlier and become expensive to change.</li>
          <li>Version skew can create support and compatibility overhead.</li>
          <li>Quality variance increases without stronger contract testing.</li>
        </ul>
      </div>
    </div>
    <div class="card-compare-summary">
      <p class="card-compare-summary-title">Decision Logic</p>
      <p class="card-compare-summary-text">Choose plugin-first only if the extension surface is stable enough to document and test. If the product is still changing at the primitive level, keep integration points internal for one more cycle.</p>
    </div>
    <div class="card-footer">Architecture Review · Recommendation Snapshot</div>
  </div>
</div>