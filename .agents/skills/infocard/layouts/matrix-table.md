# Matrix Table Layout

**Layout**: Labeled row × column matrix with selectively highlighted cells and a legend strip
**Best for**: MxN classification grids where both axes carry meaning — task type × complexity, capability × tier, persona × journey stage

## Template

<div style="max-width: 880px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafafa; padding: 36px 40px; font-family: sans-serif; color: #111; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 28px; font-weight: 700; line-height: 1.2; color: #111; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 18px; background: #111; }
    .card-subtitle { margin: 0 0 22px; font-size: 14px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-matrix { width: 100%; border-collapse: collapse; background: #ffffff; font-size: 12px; }
    .card-matrix th, .card-matrix td { border: 1px solid rgba(0,0,0,0.1); padding: 10px 12px; text-align: left; vertical-align: top; line-height: 1.5; }
    .card-matrix th { background: #111; color: #fafafa; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    .card-matrix th.row-head { background: rgba(0,0,0,0.05); color: #111; width: 20%; }
    .card-matrix td.row-head { background: rgba(0,0,0,0.05); color: #111; font-weight: 700; }
    .card-matrix td .card-matrix-cell-sub { display: block; margin-top: 2px; font-size: 10px; font-weight: 700; letter-spacing: 0.05em; color: #777; }
    .card-matrix td.t1 { background: rgba(0,0,0,0.06); }
    .card-matrix td.t2 { background: rgba(0,0,0,0.03); }
    .card-matrix td.t3 { background: #ffffff; }
    .card-matrix td.hl { box-shadow: inset 0 0 0 2px #111; }
    .card-legend { margin-top: 14px; padding: 10px 14px; background: rgba(0,0,0,0.03); border-left: 3px solid #111; font-size: 12px; line-height: 1.55; color: #333; }
    .card-legend-label { display: block; margin-bottom: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #888; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Classification · MxN Matrix</p>
    <h1 class="card-title">Task Complexity vs Processing Depth</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Cells are not just positions — they name the archetype that lives there. Highlighted cells mark the investments the program has already committed to.</p>
    <table class="card-matrix">
      <thead>
        <tr>
          <th class="row-head">Task ↓ &nbsp; / &nbsp; Depth →</th>
          <th>P1 · Parse</th>
          <th>P2 · Retrieve</th>
          <th>P3 · Reason</th>
          <th>P4 · Generate</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="row-head">T1 · Cross-function</td>
          <td class="t1">Email triage<span class="card-matrix-cell-sub">Intake · shallow</span></td>
          <td class="t1">Case lookup<span class="card-matrix-cell-sub">Ranked recall</span></td>
          <td class="t1 hl">Root-cause brief<span class="card-matrix-cell-sub">Flagship</span></td>
          <td class="t1 hl">Stakeholder memo<span class="card-matrix-cell-sub">Flagship</span></td>
        </tr>
        <tr>
          <td class="row-head">T2 · Multi-station</td>
          <td class="t2">Field extraction<span class="card-matrix-cell-sub">Structured</span></td>
          <td class="t2">Cross-source join<span class="card-matrix-cell-sub">Bounded</span></td>
          <td class="t2 hl">Compliance check<span class="card-matrix-cell-sub">Gated</span></td>
          <td class="t2">Template render<span class="card-matrix-cell-sub">Controlled</span></td>
        </tr>
        <tr>
          <td class="row-head">T3 · Single-step</td>
          <td class="t3">Intent classify</td>
          <td class="t3">Knowledge lookup</td>
          <td class="t3">Rule match</td>
          <td class="t3">Short reply</td>
        </tr>
      </tbody>
    </table>
    <div class="card-legend">
      <span class="card-legend-label">Reading the Matrix</span>
      Darker rows carry more coordination cost. The framed cells are the crown jewels — they need the strongest review, the largest models, and the tightest evaluation loop. Lighter cells can ship with lighter controls.
    </div>
    <div class="card-footer">Program Map · Planning Artifact</div>
  </div>
</div>

## Variations

- **Smaller grid**: a 2x3 or 3x3 remains readable; beyond 4x5 the cells get too narrow to carry a named archetype.
- **Axis swap**: put the heavier axis on rows when row labels need more room to breathe.
- **Tier banding**: use `t1` / `t2` / `t3` to shade whole rows or whole columns, not individual cells — the goal is to show gradient across the axis, not checkerboard noise.
- **Highlights sparingly**: at most one-quarter of the cells should carry `hl`. Over-highlighting defeats the point.

## When Not to Use

- The axes are exactly two values each → use `quadrant-matrix`.
- Only one axis has meaning; the other is a flat list → use `comparison` or `badge-grid`.
- Cells carry long paragraphs, not short archetype names → use `stacked-modules` with subsection tables instead.
