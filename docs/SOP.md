# SOP — daily workflows

One-page cheat sheet. For setup / domain ownership / pitfalls see
[`ONBOARDING.md`](./ONBOARDING.md). For Linear conventions see
[`LINEAR.md`](./LINEAR.md).

---

## 🐛 Found a bug

1. Reproduce it.
2. `linear issue create` (or web) in **KOB → Pre-1.0 整理**.
3. Title: `fix: <imperative, lowercase>` — e.g. `fix: composer 失焦`.
4. Description: **what / why / how-to-repro**.
5. Label `Bug`. Priority **High** only if it blocks; otherwise leave.
6. Don't assign unless you know who owns the area.

If you can't reproduce, file as `investigate:` instead and assign to the
area owner — don't guess at the cause.

## 🛠 Picking up work

```bash
linear issue list --cycle active   # what's in this cycle
linear issue start KOB-N           # branches + assigns + In Progress
```

Then:

1. Read any `docs/*.md` files the issue links.
2. Code.
3. After every change: `bun typecheck` + `bun test`.
4. If user-visible: behavior test via the harness.
5. Push, then `linear issue pr KOB-N` to open a PR (auto-links).

Pull from the **cycle**, not the backlog, unless something is on fire.

## 👀 Reviewing a PR

1. Pull the branch. Run it locally if user-visible.
2. Behavior-test the affected pane.
3. Comment by line. Tag severity: `nit` / `suggestion` / `blocker`.
4. CI must be green. **No `--no-verify`.**

## 🚢 Shipping a cycle

1. End of cycle: `linear cycle view current` — what shipped vs slipped.
2. Update `CHANGELOG.md` for user-visible changes.
3. Tag + publish (`packages/kobe`).
4. Slipped items roll to next cycle automatically.

## 🚨 When to escalate to Jackson

- Architectural decisions not in `DESIGN.md`.
- 3-strike: same root cause failed 3 times.
- Cross-domain conflict that needs scope adjudication.
- Wave gates G0–G4 (see `PLAN.md`).

**Don't escalate**: type errors, "did this commit go through" (`git log`),
file naming inside your own domain.

## 📝 Commit / PR rules

- Commit message: `<type>: <stream-id-or-issue> — <one-line summary>`
- **No** `Co-Authored-By: Claude` or any AI attribution.
- **No** `--no-verify` / `--no-gpg-sign`. Fix the hook, don't bypass it.
- One issue → one PR when feasible. Larger work splits into parent +
  sub-issues.
