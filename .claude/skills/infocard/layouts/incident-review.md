# Incident Review Layout

**Layout**: Postmortem card with timeline, root cause, impact, and remediation tracks
**Best for**: Postmortems, outage reviews, incident summaries, reliability follow-ups, operational retrospectives

## Template

<div style="max-width: 880px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafaf8; padding: 40px; font-family: sans-serif; color: #171717; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 30px; font-weight: 700; line-height: 1.2; color: #171717; }
    .card-subtitle { margin: 0 0 18px; font-size: 15px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 22px; background: #171717; }
    .card-sequence { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 14px; }
    .card-section { padding: 16px 18px; background: rgba(0,0,0,0.03); border-top: 4px solid #171717; }
    .card-section-title { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #666; }
    .card-section-text { margin: 0; font-size: 14px; line-height: 1.58; color: #444; }
    .card-sequence-list { list-style: none; margin: 0; padding: 0; }
    .card-sequence-list.timeline li { display: grid; grid-template-columns: 58px 1fr; gap: 10px; margin-bottom: 8px; font-size: 13px; line-height: 1.55; color: #444; }
    .card-sequence-list.timeline li:last-child { margin-bottom: 0; }
    .card-sequence-list.timeline strong { color: #171717; }
    .card-sequence-list.arrow li { position: relative; padding-left: 16px; margin-bottom: 8px; font-size: 13px; line-height: 1.55; color: #444; }
    .card-sequence-list.arrow li:last-child { margin-bottom: 0; }
    .card-sequence-list.arrow li::before { content: '→'; position: absolute; left: 0; color: #171717; font-weight: 700; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Postmortem · Incident Review</p>
    <h1 class="card-title">Queue Saturation Incident Snapshot</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Use this layout when the audience needs a compact operational reading: what happened, why it happened, who was affected, and what will change next.</p>
    <div class="card-sequence">
      <div>
        <div class="card-section">
          <p class="card-section-title">Timeline</p>
          <ul class="card-sequence-list timeline">
            <li><strong>03:14</strong><span>Consumer lag alert triggered after retry volume spiked on two partitions.</span></li>
            <li><strong>03:19</strong><span>Malformed payload source isolated and new intake throttled.</span></li>
            <li><strong>03:26</strong><span>Replay lane enabled for validated jobs with reduced concurrency.</span></li>
            <li><strong>03:33</strong><span>Queue depth normalized and customer latency returned to baseline.</span></li>
          </ul>
        </div>
      </div>
      <div>
        <div class="card-section">
          <p class="card-section-title">Root Cause</p>
          <p class="card-section-text">Retry amplification met insufficient consumer headroom. Earlier warning signals existed, but alert thresholds were tuned to absolute lag rather than unstable retry patterns.</p>
        </div>
        <div class="card-section" style="margin-top: 14px;">
          <p class="card-section-title">Remediation</p>
          <ul class="card-sequence-list arrow">
            <li>Alert on retry concentration, not only queue depth.</li>
            <li>Pre-scale workers during replay conditions.</li>
            <li>Add schema guardrails at intake instead of downstream quarantine.</li>
          </ul>
        </div>
      </div>
    </div>
    <div class="card-footer">SRE · Incident Archive</div>
  </div>
</div>