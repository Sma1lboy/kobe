# Station Workflow Layout

**Layout**: Vertical stack of workstation rows; each row exposes an ID-badged header plus a labeled multi-column attribute strip
**Best for**: Detailed workflow breakdowns where each step carries several structured attributes — inputs, processing, outputs, approval gates, durations — that a single-line description would flatten

## Template

<div style="max-width: 880px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafafa; padding: 36px 40px; font-family: sans-serif; color: #111; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 28px; font-weight: 700; line-height: 1.2; color: #111; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 18px; background: #111; }
    .card-subtitle { margin: 0 0 22px; font-size: 14px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-stations { display: flex; flex-direction: column; gap: 10px; }
    .card-station { padding: 12px 16px; background: #ffffff; border: 1px solid rgba(0,0,0,0.08); border-left: 4px solid #111; }
    .card-station.hl { background: rgba(0,0,0,0.04); }
    .card-station-h { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px dashed rgba(0,0,0,0.1); }
    .card-station-id { display: inline-block; padding: 2px 7px; background: #111; color: #fafafa; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; }
    .card-station-name { font-size: 14px; font-weight: 700; color: #111; }
    .card-station-tag { display: inline-block; margin-left: auto; padding: 2px 7px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; background: rgba(0,0,0,0.08); color: #111; }
    .card-station-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
    .card-station-cell { font-size: 12px; line-height: 1.5; color: #333; }
    .card-station-cell-label { display: block; margin-bottom: 3px; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #888; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Workflow · Station Detail</p>
    <h1 class="card-title">Order Intake Pipeline</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Each station is one named step with a committed contract: what it takes in, what it produces, what can approve it, and how long it should take end to end.</p>
    <div class="card-stations">
      <div class="card-station">
        <div class="card-station-h">
          <span class="card-station-id">W1</span>
          <span class="card-station-name">Request Intake</span>
          <span class="card-station-tag">Automated</span>
        </div>
        <div class="card-station-row">
          <div class="card-station-cell"><span class="card-station-cell-label">Input</span>Email, form, or partner webhook</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Process</span>Intent parse, identity match, entity extract</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Output</span>Structured request payload</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Gate</span>None — pass-through</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Duration</span>Under 60 seconds</div>
        </div>
      </div>
      <div class="card-station">
        <div class="card-station-h">
          <span class="card-station-id">W2</span>
          <span class="card-station-name">Case Retrieval</span>
          <span class="card-station-tag">Automated</span>
        </div>
        <div class="card-station-row">
          <div class="card-station-cell"><span class="card-station-cell-label">Input</span>Request payload from W1</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Process</span>Vector search over prior cases plus tag scoring</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Output</span>Ranked neighbor set with evidence</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Gate</span>None — auto-pass</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Duration</span>Under 2 minutes</div>
        </div>
      </div>
      <div class="card-station hl">
        <div class="card-station-h">
          <span class="card-station-id">W3</span>
          <span class="card-station-name">Cross-System Reconciliation</span>
          <span class="card-station-tag">Assisted</span>
        </div>
        <div class="card-station-row">
          <div class="card-station-cell"><span class="card-station-cell-label">Input</span>W1 payload plus W2 neighbors</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Process</span>Bounded tool calls across systems of record</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Output</span>Evidence bundle with anomalies flagged</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Gate</span>Analyst spot-check on flagged items</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Duration</span>Under 15 minutes</div>
        </div>
      </div>
      <div class="card-station">
        <div class="card-station-h">
          <span class="card-station-id">W4</span>
          <span class="card-station-name">Decision &amp; Response</span>
          <span class="card-station-tag">Reviewed</span>
        </div>
        <div class="card-station-row">
          <div class="card-station-cell"><span class="card-station-cell-label">Input</span>W3 bundle plus policy context</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Process</span>Draft decision and response letter</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Output</span>Signed response and audit record</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Gate</span>Two-signature review before send</div>
          <div class="card-station-cell"><span class="card-station-cell-label">Duration</span>Under one working day</div>
        </div>
      </div>
    </div>
    <div class="card-footer">Process Reference · Intake v2</div>
  </div>
</div>

## Variations

- **Four columns**: drop one cell (e.g. `Gate`) and switch to `repeat(4, 1fr)` for lighter content.
- **Emphasis station**: add the `hl` modifier on the station that carries the highest decision weight; limit to one station per card.
- **Duration-only strip**: keep the header row and compress attributes into a single "Before / After" duration comparison when the card is about speed, not contract.

## When Not to Use

- The workflow has more than six stations → switch to `timeline-flow` and move attributes into hover details or a companion table.
- Each station carries only one attribute (just a description) → `timeline-flow` is a better fit.
- The stations are parallel, not sequential → use `badge-grid` or `bento-grid`.
