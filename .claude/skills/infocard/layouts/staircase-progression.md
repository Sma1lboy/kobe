# Staircase Progression Layout

**Layout**: Three or four phase columns with stepped heights, each phase visibly taller than the previous to signal accumulation
**Best for**: Maturity curves, capability build-up stories, phased scope expansion where later phases carry strictly more surface area than earlier ones

## Template

<div style="max-width: 880px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafafa; padding: 36px 40px; font-family: sans-serif; color: #111; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 28px; font-weight: 700; line-height: 1.2; color: #111; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 18px; background: #111; }
    .card-subtitle { margin: 0 0 22px; font-size: 14px; line-height: 1.55; color: #444; max-width: 620px; }
    .card-stair { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; align-items: end; }
    .card-stair-step { padding: 16px 14px; background: #ffffff; border: 1px solid rgba(0,0,0,0.08); border-bottom: 5px solid #111; display: flex; flex-direction: column; }
    .card-stair-step.s1 { height: 300px; border-bottom-color: rgba(0,0,0,0.35); }
    .card-stair-step.s2 { height: 340px; border-bottom-color: #111; }
    .card-stair-step.s3 { height: 380px; background: rgba(0,0,0,0.04); }
    .card-stair-h { text-align: left; margin: 0 0 10px; padding-bottom: 8px; border-bottom: 1.5px solid rgba(0,0,0,0.12); }
    .card-stair-h-label { display: block; font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #888; }
    .card-stair-h-name { display: block; margin-top: 4px; font-size: 16px; font-weight: 700; color: #111; line-height: 1.2; }
    .card-stair-h-big { display: block; margin-top: 6px; font-size: 26px; font-weight: 800; color: #111; line-height: 1; letter-spacing: -0.02em; }
    .card-stair-row { margin-top: 8px; padding-top: 6px; border-top: 1px dashed rgba(0,0,0,0.08); font-size: 12px; line-height: 1.5; color: #333; }
    .card-stair-row-label { display: block; margin-bottom: 2px; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #888; }
    .card-stair-row.hero { background: rgba(0,0,0,0.05); padding: 6px 8px; border-top: none; margin-top: 8px; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Phased Plan · Accumulating Scope</p>
    <h1 class="card-title">Three Stages of Platform Maturity</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Each step is visibly taller than the last. The height encodes the growth of scope, not a prettier roadmap — phase three should feel heavier because it carries more than phase one.</p>
    <div class="card-stair">
      <div class="card-stair-step s1">
        <div class="card-stair-h">
          <span class="card-stair-h-label">Phase 1 · Focus</span>
          <span class="card-stair-h-name">Anchor Wins</span>
          <span class="card-stair-h-big">6</span>
        </div>
        <div class="card-stair-row hero">
          <span class="card-stair-row-label">Scope</span>
          Two flagship workflows plus their shared foundation.
        </div>
        <div class="card-stair-row">
          <span class="card-stair-row-label">Mode</span>
          Sequential handoff with human review on every exit.
        </div>
        <div class="card-stair-row">
          <span class="card-stair-row-label">Exit Gate</span>
          Flagship ROI validated; baseline infrastructure in production.
        </div>
      </div>
      <div class="card-stair-step s2">
        <div class="card-stair-h">
          <span class="card-stair-h-label">Phase 2 · Breadth</span>
          <span class="card-stair-h-name">Line-of-Business Rollout</span>
          <span class="card-stair-h-big">+13</span>
        </div>
        <div class="card-stair-row hero">
          <span class="card-stair-row-label">Scope</span>
          Cross-functional workflows reach every core team.
        </div>
        <div class="card-stair-row">
          <span class="card-stair-row-label">Mode</span>
          Scoped peer-to-peer calls; audit rails fully enabled.
        </div>
        <div class="card-stair-row">
          <span class="card-stair-row-label">Exit Gate</span>
          Candidate workflows graduate to production status.
        </div>
      </div>
      <div class="card-stair-step s3">
        <div class="card-stair-h">
          <span class="card-stair-h-label">Phase 3 · Depth</span>
          <span class="card-stair-h-name">Federated Coverage</span>
          <span class="card-stair-h-big">+14</span>
        </div>
        <div class="card-stair-row hero">
          <span class="card-stair-row-label">Scope</span>
          Back-office and governance workflows join the platform.
        </div>
        <div class="card-stair-row">
          <span class="card-stair-row-label">Mode</span>
          Cross-site orchestration under a unified control plane.
        </div>
        <div class="card-stair-row">
          <span class="card-stair-row-label">Exit Gate</span>
          Platform released externally; industry extensions shipped.
        </div>
      </div>
    </div>
    <div class="card-footer">Maturity Curve · Program Plan</div>
  </div>
</div>

## Variations

- **Four steps**: switch to `repeat(4, 1fr)` and add an `s4` height above `s3`. Keep the height step consistent (roughly `+40px` each).
- **Count variant**: the big number on each step can encode scope (scenarios, teams, workflows) or time (months). Pick one axis per card and keep it consistent.
- **Inverted stair**: for de-scoping or wind-down stories, reverse the heights so later phases shrink. Rare; use only when the narrative really is contraction.

## When Not to Use

- All phases carry equal weight → use `roadmap-board`.
- There is no clear accumulation story (each phase replaces, not extends, the previous) → use `comparison`.
- More than four phases → the stair becomes gimmicky; switch to `timeline-flow`.
