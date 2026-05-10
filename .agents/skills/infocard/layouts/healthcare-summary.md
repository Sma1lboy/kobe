# Healthcare Summary Layout

**Layout**: Calm care-summary card with status, focus areas, guidance, and follow-up blocks
**Best for**: Clinical overviews, patient summaries, care snapshots, health education, medical communication

## Template

<div style="max-width: 860px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafaf8; padding: 40px; font-family: sans-serif; color: #171717; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #171717; }
    .card-subtitle { margin: 0 0 18px; font-size: 15px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #171717; }
    .card-doc { display: grid; grid-template-columns: 0.9fr 1.1fr; gap: 14px; }
    .card-section { padding: 16px 18px; background: rgba(0,0,0,0.03); border-top: 4px solid #171717; }
    .card-section.card-section-status { }
    .card-status-value { margin: 0; font-size: 40px; font-weight: 700; line-height: 1; color: #171717; }
    .card-status-label { margin: 6px 0 0; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #777; }
    .card-section-title { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #666; }
    .card-section-text { margin: 0; font-size: 14px; line-height: 1.58; color: #444; }
    .card-doc-list { list-style: none; margin: 0; padding: 0; }
    .card-doc-list li { position: relative; padding-left: 16px; margin-bottom: 8px; font-size: 13px; line-height: 1.55; color: #444; }
    .card-doc-list li:last-child { margin-bottom: 0; }
    .card-doc-list.bullet li::before { content: '•'; position: absolute; left: 0; color: #171717; }
    .card-doc-side { display: grid; gap: 14px; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Care Summary · Follow-Up Note</p>
    <h1 class="card-title">Current Plan Focuses on Routine Stability and Monitoring</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">This layout is for concise care communication where clarity, calm tone, and actionable next steps matter more than visual drama.</p>
    <div class="card-doc">
      <div>
        <div class="card-section card-section-status">
          <p class="card-status-value">Stable</p>
          <p class="card-status-label">Current status</p>
        </div>
        <div class="card-section" style="margin-top: 14px;">
          <p class="card-section-title">Focus Areas</p>
          <ul class="card-doc-list bullet">
            <li>Medication consistency</li>
            <li>Symptom monitoring</li>
            <li>Follow-up adherence</li>
          </ul>
        </div>
      </div>
      <div class="card-doc-side">
        <div class="card-section">
          <p class="card-section-title">Guidance</p>
          <p class="card-section-text">Continue the current plan, keep instructions simple, and document any changes in symptoms before the next visit rather than making unsupervised adjustments.</p>
        </div>
        <div class="card-section">
          <p class="card-section-title">Follow-Up</p>
          <p class="card-section-text">Return in two weeks for reassessment, or earlier if symptoms worsen, adherence becomes difficult, or new side effects emerge.</p>
        </div>
      </div>
    </div>
    <div class="card-footer">Clinical Communication · Summary Card</div>
  </div>
</div>