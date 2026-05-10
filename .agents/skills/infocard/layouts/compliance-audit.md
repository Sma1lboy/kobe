# Compliance Audit Layout

**Layout**: Audit-oriented summary with scope, findings, evidence status, and remediation actions
**Best for**: Audit summaries, control reviews, compliance status updates, evidence tracking, security assessments

## Template

<div style="max-width: 880px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafaf8; padding: 40px; font-family: sans-serif; color: #171717; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #171717; }
    .card-subtitle { margin: 0 0 18px; font-size: 15px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #171717; }
    .card-review { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 14px; }
    .card-review-main { display: grid; gap: 14px; }
    .card-review-panel { padding: 16px 18px; background: rgba(0,0,0,0.03); border-top: 4px solid #171717; }
    .card-review-title { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #666; }
    .card-review-text { margin: 0; font-size: 14px; line-height: 1.58; color: #444; }
    .card-review-list { list-style: none; margin: 0; padding: 0; }
    .card-review-list li { position: relative; padding-left: 18px; margin-bottom: 8px; font-size: 13px; line-height: 1.55; color: #444; }
    .card-review-list li:last-child { margin-bottom: 0; }
    .card-review-list li::before { content: '!'; position: absolute; left: 0; color: #171717; font-weight: 700; }
    .card-review-statgrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .card-review-statbox { padding: 16px; background: rgba(0,0,0,0.06); border-top: 4px solid #171717; }
    .card-review-stat { margin: 0; font-size: 34px; font-weight: 700; line-height: 1; color: #171717; }
    .card-review-stat-label { margin: 6px 0 0; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #777; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Audit Review · Compliance Status</p>
    <h1 class="card-title">Most Gaps Were Evidentiary, Not Structural</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">This layout is for audit rounds where the system is mostly in place, but the quality of evidence collection and remediation tracking still determines outcome quality.</p>
    <div class="card-review">
      <div class="card-review-main">
        <div class="card-review-panel">
          <p class="card-review-title">Scope</p>
          <p class="card-review-text">Access controls, incident response records, vendor due diligence, and change management logs were sampled across the quarter.</p>
        </div>
        <div class="card-review-panel">
          <p class="card-review-title">Findings</p>
          <ul class="card-review-list">
            <li>Control execution was usually present, but supporting evidence was inconsistently retained.</li>
            <li>Vendor review cadence drifted in lower-risk categories.</li>
            <li>One remediation item lacked a named owner after policy revision.</li>
          </ul>
        </div>
      </div>
      <div>
        <div class="card-review-statgrid">
          <div class="card-review-statbox"><p class="card-review-stat">27</p><p class="card-review-stat-label">Controls sampled</p></div>
          <div class="card-review-statbox"><p class="card-review-stat">3</p><p class="card-review-stat-label">Open findings</p></div>
          <div class="card-review-statbox"><p class="card-review-stat">89%</p><p class="card-review-stat-label">Evidence complete</p></div>
          <div class="card-review-statbox"><p class="card-review-stat">21d</p><p class="card-review-stat-label">Remediation target</p></div>
        </div>
      </div>
    </div>
    <div class="card-footer">Compliance Office · Audit Summary</div>
  </div>
</div>