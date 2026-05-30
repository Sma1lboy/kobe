# Linear conventions

Source of truth for how the kobe team uses Linear. Read this before opening
issues, picking up work, or running `linear` from the repo. Update when the
conventions shift.

## Workspace layout

- **Workspace**: `codesfox` — https://linear.app/codesfox
- **Team**: `KOB` (Kobe). All kobe work lives here. The legacy `COD`
  (Codesfox) team is dormant; its old projects are status `canceled`. Do not
  open new work there.
- **Default project**: `0.6 tmux 版本` — the current product line after the v0.6
  reshape: tmux Handover, per-Task tmux Sessions, ChatTabs as tmux windows,
  Tasks/Ops panes, and inner-first workflow polish.
- **Legacy project**: `0.5 opentui 版本` — shipped/stale self-rendered opentui
  chat work. Preserve it for history; do not file new v0.6 tmux work there.

## CLI defaults (this repo)

`.linear.toml` at the repo root pins the workspace + team, so commands run
from the kobe checkout target KOB without flags:

```bash
linear issue list                # KOB issues
linear issue create -t "fix: ..."  # creates in KOB
linear cycle list                # KOB cycles
```

Auth: `linear auth login` (browser OAuth, one-time per machine). Token is
stored in the system keyring, not the repo.

## Layered concepts (one-liner each)

- **Team (KOB)** — the kobe work group. Holds cycles, labels, members.
- **Project** — a work package with start/end (e.g. `0.6 tmux 版本`,
  `v1.1 perf`). Many can be open at once; a project is *not* the same as a
  git repo.
- **Cycle** — a 2-week sprint window on the team. Cuts across projects.
- **Issue** — the actual ticket. Lives in a project (or floats in the team
  backlog) and is scheduled into a cycle when picked up.
- **Document** — long-form text attached to a project (specs, RFCs, meeting
  notes that don't belong in the repo).
- **Milestone / Initiative** — not used at 4-person scale. Skip.

## Cadence

- **Cycles**: biweekly, Monday → Sunday, 4 upcoming pre-rolled. Cycle 1
  starts 2026-05-11.
- **Active cycle**: `linear cycle view current` (or `linear cycle list`).
- **Auto-assign**: starting an issue (`linear issue start <id>`) puts it in
  the current cycle. Completing it does not auto-assign — finish issues
  inside their original cycle.

## Labels (workspace-scoped)

| Label | When |
|---|---|
| `Bug` | Broken behavior, regression, crash. |
| `Feature` | New user-visible capability. |
| `Tech Debt` | Refactor, cleanup, paying down complexity. No user impact. |
| `Doc` | Docs-only work (README, `docs/`, code comments). |
| `Chore` | Build / CI / config / deps / housekeeping. |

Each issue gets exactly one. Priority is set via Linear's built-in priority
field (Urgent / High / Medium / Low / No priority), not via labels.

## Issue conventions

- **Title**: imperative, lowercase, conventional-commit style verb. No
  trailing period.
  - ✅ `fix: composer 失焦后 Tab 卡住`
  - ✅ `feat: sidebar 支持模糊搜索`
  - ❌ `Fix the composer bug.` / `composer issue`
- **Description**: what / why / how-to-repro for bugs; what / why / acceptance
  for features. Link related issues with `KOB-N`.
- **One issue = one PR** when feasible. Larger work splits into a parent +
  sub-issues.
- **Assignee**: set when picked up, not at file time.
- **Priority**: only set Urgent/High when it's true. Default is No priority
  for backlog grooming later.

## Branch + PR workflow

`linear-cli` is git-aware. Use it instead of branching by hand.

```bash
linear issue start KOB-12
# → checks out a branch like jackson/kob-12-fix-composer
# → moves issue to In Progress and assigns to you

# work, commit, push as normal
git push -u origin HEAD

linear issue pr KOB-12   # opens a PR with KOB-12 in the title/body
```

PR titles include the issue ID (`KOB-12`) so Linear auto-links and closes the
issue on merge. Don't manually mark an issue Done if a PR will close it.

## Documents vs repo markdown

- **Repo markdown** (`docs/*.md`) — load-bearing source of truth: `DESIGN.md`,
  `PLAN.md`, `HARNESS.md`, this file. Anything an agent must read before
  touching code goes here.
- **Linear Document** (attached to a project) — meeting notes, throwaway
  research, status writeups, designs that haven't earned a place in the
  repo yet. Move into `docs/` if it becomes load-bearing.

## What lives where (cheat sheet)

| Need | Where |
|---|---|
| "What's the design philosophy?" | `docs/DESIGN.md` |
| "What stream am I working on?" | `docs/PLAN.md` |
| "What's queued for this sprint?" | Linear → KOB → Cycle |
| "Why was this issue rejected?" | Linear issue comments |
| "How do I run / test / ship?" | `CLAUDE.md`, `CHANGELOG.md` |
| "Throwaway design doc" | Linear Document on the project |
| "Permanent design doc" | `docs/<NAME>.md` |

## Maintenance

- New top-level project: open in Linear UI or `linear project create -t KOB`.
- New label: keep the 5 above unless you've discussed adding one. Avoid
  one-off labels.
- Stale projects: set status `canceled`, don't delete (preserves history).
- Stale issues: comment with rationale, set status `Canceled`.
