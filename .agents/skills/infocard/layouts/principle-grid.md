# Principle Grid Layout

**Layout**: Row of numbered tenet cards, each carrying a short title with a paired anti-pattern and application block below
**Best for**: Design principles, doctrine cards, methodology tenets, engineering values — anywhere a rule only makes sense next to what it rejects

## Template

<div style="max-width: 900px; box-sizing: border-box; position: relative;">
  <style scoped>
    .card { position: relative; background: #fafafa; padding: 36px 40px; font-family: sans-serif; color: #111; line-height: 1.6; }
    .card-meta { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #888; }
    .card-title { margin: 0 0 14px; font-size: 28px; font-weight: 700; line-height: 1.2; color: #111; }
    .card-bar { width: 80px; height: 6px; margin: 0 0 18px; background: #111; }
    .card-subtitle { margin: 0 0 22px; font-size: 14px; line-height: 1.55; color: #444; max-width: 640px; }
    .card-principles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
    .card-principle { padding: 14px 12px; background: #ffffff; border: 1px solid rgba(0,0,0,0.08); border-top: 3px solid #111; display: flex; flex-direction: column; }
    .card-principle-h { font-size: 13px; font-weight: 700; color: #111; line-height: 1.35; margin: 0 0 8px; }
    .card-principle-h .card-principle-n { display: inline-block; width: 20px; height: 20px; line-height: 20px; text-align: center; background: #111; color: #fafafa; font-size: 11px; font-weight: 700; margin-right: 6px; }
    .card-principle-row { margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(0,0,0,0.08); font-size: 12px; line-height: 1.5; color: #333; }
    .card-principle-row-label { display: block; margin-bottom: 3px; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #888; }
    .card-principle-row.anti .card-principle-row-label { color: #6b6b6b; }
    .card-principle-row.apply .card-principle-row-label { color: #111; }
    .card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 11px; color: #888; }
  </style>
  <div class="card">
    <p class="card-meta">Doctrine · Principle Set</p>
    <h1 class="card-title">Five Rules We Will Not Bend</h1>
    <div class="card-bar"></div>
    <p class="card-subtitle">Every principle is paired with the failure mode it rejects. If the anti-pattern never shows up in practice, the principle is probably not worth stating.</p>
    <div class="card-principles">
      <div class="card-principle">
        <p class="card-principle-h"><span class="card-principle-n">1</span>Problem before tool</p>
        <div class="card-principle-row anti">
          <span class="card-principle-row-label">Anti-Pattern</span>
          Picking the framework first and searching for a problem to apply it to.
        </div>
        <div class="card-principle-row apply">
          <span class="card-principle-row-label">In Practice</span>
          Every proposal starts from a named user pain and a measurable outcome.
        </div>
      </div>
      <div class="card-principle">
        <p class="card-principle-h"><span class="card-principle-n">2</span>Shared primitives</p>
        <div class="card-principle-row anti">
          <span class="card-principle-row-label">Anti-Pattern</span>
          Each team rebuilds the same auth, logging, and rate-limit glue.
        </div>
        <div class="card-principle-row apply">
          <span class="card-principle-row-label">In Practice</span>
          Cross-cut concerns live in a shared core; teams extend, not re-invent.
        </div>
      </div>
      <div class="card-principle">
        <p class="card-principle-h"><span class="card-principle-n">3</span>Tiered data access</p>
        <div class="card-principle-row anti">
          <span class="card-principle-row-label">Anti-Pattern</span>
          One permission level for everything; sensitive data rides in plain traffic.
        </div>
        <div class="card-principle-row apply">
          <span class="card-principle-row-label">In Practice</span>
          Classified tiers with explicit handlers; the highest tier never leaves its boundary.
        </div>
      </div>
      <div class="card-principle">
        <p class="card-principle-h"><span class="card-principle-n">4</span>Human in the loop first</p>
        <div class="card-principle-row anti">
          <span class="card-principle-row-label">Anti-Pattern</span>
          Full automation from day one, with unbounded blast radius.
        </div>
        <div class="card-principle-row apply">
          <span class="card-principle-row-label">In Practice</span>
          Review gates on every outbound action until the error budget proves stable.
        </div>
      </div>
      <div class="card-principle">
        <p class="card-principle-h"><span class="card-principle-n">5</span>Evaluate on a clock</p>
        <div class="card-principle-row anti">
          <span class="card-principle-row-label">Anti-Pattern</span>
          Launch-day benchmarks, then silence; drift goes unnoticed for months.
        </div>
        <div class="card-principle-row apply">
          <span class="card-principle-row-label">In Practice</span>
          Rolling metrics with thresholds that trigger rollback without a meeting.
        </div>
      </div>
    </div>
    <div class="card-footer">Engineering Principles · Revision 3</div>
  </div>
</div>

## Variations

- **Four principles**: switch `repeat(5, 1fr)` to `repeat(4, 1fr)` for wider, more readable cards. Avoid six — density collapses readability.
- **Three-row variant**: add an optional `card-principle-row.metric` block carrying a concrete KPI (e.g. "rollback within 15 minutes"). Keep to one metric per card.
- **Emphasis column**: promote one card with a heavier border (`border-top: 5px solid`) when the principle carries more weight than the others.

## When Not to Use

- Only two positions to contrast → use `pros-cons`.
- The points share no common shape (some are tenets, some are tactics) → use `stacked-modules`.
- No anti-pattern exists; the items are just features → use `badge-grid`.
