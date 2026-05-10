# Policy Memo Layout

**Layout**: Formal memo structure with policy thesis, change summary, rationale, and enforcement notes
**Best for**: Internal policy changes, governance decisions, process rules, compliance guidance, formal guidance notes

## Template

<div style="max-width: 860px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafaf8; padding: 40px; font-family: sans-serif; color: #171717; line-height: 1.62; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #171717; max-width: 640px; }
    .card-subtitle { margin: 0 0 18px; font-size: 15px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #171717; }
    .card-doc { display: grid; gap: 14px; }
    .card-section { padding: 16px 18px; background: rgba(0,0,0,0.03); border-top: 4px solid #171717; }
    .card-section-title { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #666; }
    .card-section-text { margin: 0; font-size: 14px; line-height: 1.6; color: #444; }
    .card-doc-list { list-style: none; margin: 0; padding: 0; }
    .card-doc-list li { position: relative; padding-left: 18px; margin-bottom: 8px; font-size: 13px; line-height: 1.55; color: #444; }
    .card-doc-list li:last-child { margin-bottom: 0; }
    .card-doc-list.rule li::before { content: '§'; position: absolute; left: 0; color: #171717; font-weight: 700; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Policy Memo · Internal Guidance</p>
    <h1 class="card-title">Approval Paths Must Be Explicit Before Exceptions Go Live</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Use this format when the audience needs a policy change explained in plain language: what changed, why it changed, and how enforcement now works.</p>
    <div class="card-doc">
      <div class="card-section">
        <p class="card-section-title">Thesis</p>
        <p class="card-section-text">Operational exceptions are now treated as governed states rather than informal workarounds. Approval, duration, and review ownership must be defined before implementation.</p>
      </div>
      <div class="card-section">
        <p class="card-section-title">What Changed</p>
        <ul class="card-doc-list rule">
          <li>Every exception requires a named approver and expiry date.</li>
          <li>Exceptions older than 30 days require monthly revalidation.</li>
          <li>Unowned exceptions are considered non-compliant by default.</li>
        </ul>
      </div>
      <div class="card-section">
        <p class="card-section-title">Why</p>
        <p class="card-section-text">The previous model allowed urgent decisions to persist without clear review boundaries. This created operational debt and inconsistent accountability across teams.</p>
      </div>
      <div class="card-section">
        <p class="card-section-title">Enforcement</p>
        <p class="card-section-text">Quarterly governance review will now include exception inventories, expiry status, and unresolved ownership gaps as standing agenda items.</p>
      </div>
    </div>
    <div class="card-footer">Governance Office · Effective Immediately</div>
  </div>
</div>