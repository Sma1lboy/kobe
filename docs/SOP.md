# SOP — daily workflows

One-page cheat sheet. For setup / domain ownership / pitfalls see
[`ONBOARDING.md`](./ONBOARDING.md). For local tracking conventions see
[`LINEAR.md`](./LINEAR.md).

---

## 🐛 Found a bug

1. Reproduce it.
2. Record it locally in `HANDOFF.md` if it is an active risk, or a focused `docs/*.md` note if it is durable.
3. Title: `fix: <imperative, lowercase>` — e.g. `fix: composer 失焦`.
4. Description: **what / why / how-to-repro**.
5. Include reproduction commands and relevant paths.

If you can't reproduce, file as `investigate:` instead and assign to the
area owner — don't guess at the cause.

## 🛠 Picking up work

```bash
git status --short
sed -n '1,120p' HANDOFF.md
```

Then:

1. Read the relevant `docs/*.md` files.
2. Code.
3. After every change: `bun typecheck` + `bun test`.
4. If user-visible: behavior test via the harness.
5. Update `CHANGELOG.md` for user-visible changes, then commit when green.

Pull from `HANDOFF.md` / local docs, not stale external queues.

## 👀 Reviewing a PR

1. Pull the branch. Run it locally if user-visible.
2. Behavior-test the affected pane.
3. Comment by line. Tag severity: `nit` / `suggestion` / `blocker`.
4. CI must be green. **No `--no-verify`.**

## 🚢 Shipping a cycle

1. Review `HANDOFF.md` and recent commits — what shipped vs slipped.
2. Update `CHANGELOG.md` for user-visible changes.
3. Tag + publish (`packages/kobe`).
4. Carry slipped items forward in `HANDOFF.md`.

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
- Keep commits focused. Larger work splits into separately reviewed local slices.
