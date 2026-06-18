---
name: file-issue
description: Turn a rough idea, a bug, or a batch of unsolved problems into well-structured GitHub issue(s) and file them with `gh`, auto-classifying type + labels from the content (recommend, then confirm) and following kobe's conventions (beginner-friendly framing, concrete file pointers, an acceptance checklist, zero AI/Anthropic attribution). Handles single, batch, and "file the unsolved problems" modes. Use when the user says "file an issue", "open a GitHub issue", "draft a good first issue", "batch these as issues", "上报 issue", "提个 issue", "报个 bug", "把没解决的发上去", or wants to hand low-priority tasks to outside contributors. Distinct from the daemon-owned internal issue store (`kobe api issue-*`); this skill is for outward-facing GitHub issues.
metadata:
  internal: true
---

# File a GitHub issue

Turn a rough idea, bug report, or low-priority task into a **well-structured GitHub
issue** and file it with `gh`. The output should be something an outside contributor
can pick up cold — accurate file pointers, clear scope, explicit acceptance — not a
one-line stub.

## Scope boundary (read first)

kobe tracks its own work in the **daemon-owned issue store** (`kobe api issue-*`, the
web Issues page) — see [`docs/WORK-TRACKING.md`](../../../docs/WORK-TRACKING.md). That
is the default for internal backlog.

This skill is for **outward-facing GitHub issues** — work you intend to hand to
external contributors (especially `good first issue`s), or a public bug report. If the
user just wants to jot down internal backlog, prefer the daemon store and say so. If
they explicitly want a GitHub issue, proceed here.

## Modes

The skill handles three shapes of input — detect which from the user's ask:

- **Single** — one idea / bug → one issue. Draft it, auto-classify (Step 1), confirm,
  file. The lightest path; fine to file directly once the draft + labels are shown.
- **Batch** — a list of ideas / a backlog dump / "file these N as issues" → many issues.
  Draft all, classify each, present the whole set as a table (title + proposed labels)
  for **one** confirmation, then file them in a loop and report URLs together.
- **From unsolved problems** — the user points at problems that came up but weren't
  fixed this session ("发没解决的上去") — e.g. a known bug you hit, a deferred follow-up,
  a TODO you found. Convert each into an issue: capture the symptom/repro while it's
  fresh, mark it `bug` or `enhancement`, and note in the body that it's filed-not-fixed
  (no implied owner). Then batch-confirm and file as above.

Pick the mode, then follow the per-issue steps below for each issue.

## Hard rules (non-negotiable)

- **Filing is an outward-facing publish.** Draft first, then confirm the set before
  `gh issue create` — don't create silently. Editing an already-filed issue is fine
  without re-asking.
- **No AI / Anthropic / Claude / Codex attribution** anywhere in the title, body, or
  comments (per CLAUDE.md). No "Generated with…" footers.
- **Never invent file paths, line numbers, flags, or function names.** Every pointer in
  the body must be verified against the current tree (see Step 2). A wrong pointer
  costs a contributor 30–50% of their session reconciling a false premise.
- **Default language: English** for issue titles and bodies (the repo's contributor
  language), even when the conversation is in Chinese. Narrate to the user in whatever
  language they're using. If the user asks for another language, follow that.
- **One concern per issue.** If an idea bundles several independent tasks, split it into
  several issues (e.g. "add a theme" is one issue per theme).

## Step 0 — Confirm target repo + available labels

```bash
git remote -v                                   # confirm origin is the intended repo
gh label list --limit 60                         # use ONLY labels that already exist
```

kobe's relevant labels: `good first issue`, `enhancement`, `bug`, `documentation`,
`help wanted`, `question`. Do **not** invent labels — if a needed label is missing,
surface it and let the user create it (`gh label create`), don't guess a substitute.

## Step 1 — Auto-classify (recommend, then confirm)

Derive the type + labels from the issue's content automatically — don't ask the user to
pick from scratch. Read the idea, match it against the repo's existing labels (Step 0),
and **propose** a classification; the user confirms or overrides at the Step 4 gate
(for a batch, one confirmation covers the whole table).

How to classify from content:

- **bug** — words like "broken / throws / crashes / regression / doesn't work", or a
  repro of wrong behavior → `bug`.
- **enhancement** — "add / support / it would be nice / feature" → `enhancement`.
- **documentation** — only docs/README/comments change → `documentation`.
- **good first issue** — *additionally* apply when the task is self-contained, low-risk,
  and a *meaningful* mini-project (see the shape rubric below). Usually paired with
  `enhancement`.
- **help wanted** — maintainer wants outside help but it's not necessarily beginner-safe.

Only emit labels that exist in the repo (Step 0). If content suggests a label the repo
lacks, surface it rather than silently dropping or inventing one. When classification is
genuinely ambiguous, state your best guess + the runner-up so the confirm step is a
quick yes/no, not an open question.

The issue's shape also drives the body template (Step 3):

- **good first issue** — self-contained, low-risk, *meaningful* (a mini-project a
  contributor can own end-to-end), not a micro-cleanup. Good signals: greenfield
  feature with no existing infra (e.g. i18n, shell completions), a self-contained new
  subcommand (`kobe doctor`), or a repeatable visual contribution (a new theme).
  **Anti-signal:** "add a unit test for X" / "extract a constant" — too small to be
  worth an external contributor's onboarding cost; the user has rejected these. Aim for
  tasks that touch 1–3 files but deliver a complete, satisfying chunk of value.
- **bug** — reproducible defect. Body leads with repro steps + expected vs actual.
- **enhancement** — a feature/improvement for the maintainers, not necessarily
  beginner-friendly.

Most low-priority hand-off tasks are `good first issue` + `enhancement` together.

## Step 2 — Verify every pointer (mandatory)

Before writing the body, confirm each claim against the tree. Cheap checks that prevent
filing fiction:

```bash
# file exists + size/shape is what you think
ls -la packages/kobe/src/<path>
# the function/string/registry you're pointing at really lives there
grep -rn "BUNDLED_THEMES" packages/kobe/src/tui/context/theme/
# the thing you claim is MISSING really is absent (greenfield framing)
find packages -iname '*completion*' | grep -v node_modules    # empty => "no completions exist"
```

If you spawned an Explore agent to find candidates, **re-verify its file paths
yourself** — exploration output can carry typo'd or doubled paths (e.g.
`packages/kobe/packages/kobe/...`). Never paste an unverified path into an issue.

For greenfield framing ("there is no X today"), prove the absence with a `find`/`grep`
that comes back empty — that sentence is load-bearing for a contributor.

## Step 3 — Draft the body

Use this template for a `good first issue` / `enhancement` (trim sections that don't
apply):

```markdown
## Background
<1–3 sentences: what exists today, why this matters, what's missing. State greenfield
absence explicitly if true: "the repo has no X infrastructure at all.">

## Why it's beginner-friendly      ← only for good first issue
- <what knowledge is NOT required — e.g. "does not touch daemon/engine/orchestrator">
- <why it's safely incremental / splittable>

## Scope
1. <concrete step with the exact file path to add/edit>
2. <next step, with the registry/wiring point named>
3. <docs/README update if user-facing>

## Important notes        ← constraints that would otherwise trip a newcomer
- <e.g. "engine-owned copy is not translated — comes from AIEngine.identity">
- <e.g. "do not change DEFAULT_THEME = 'claude'">

## Acceptance
- <observable pass condition>
- <exit-code / test / screenshot expectation>
```

For a **bug**, lead instead with:

```markdown
## Repro
1. <steps>

## Expected vs actual
- Expected: …
- Actual: …

## Environment / pointers
- <version, OS, relevant file:line>
```

Style: terse, concrete, second-person imperative for scope steps. Reference code as
`file_path:line` so it's clickable. Link kobe docs with repo-relative paths
(`docs/ARCHITECTURE.md`).

## Step 4 — Confirm, then file

Show the user the drafted title(s) + body(ies) and the labels you'll apply. For a
single obvious issue you may file directly; for a batch, confirm the set first (an
`AskUserQuestion` with "file all / show full drafts / pick a subset" works well).

File with a heredoc to keep Markdown intact:

```bash
gh issue create \
  --label "good first issue" --label "enhancement" \
  --title "feat: <concise imperative title>" \
  --body "$(cat <<'EOF'
<body from Step 3>
EOF
)"
```

`gh issue create` prints the new issue URL — collect them and report back as a table
(number, title, URL). To revise after filing, use `gh issue edit <n> --title … --body …`
(same heredoc pattern); editing needs no re-confirmation.

## Step 5 — Report

Summarize what was filed (table of #/title/URL) and offer obvious follow-ups only if
they have a concrete hook: assign a milestone, split a multi-part issue, or add a few
more candidates at the same scale. Don't over-offer.
