# Issue tracker: Local Markdown

Issues and PRDs for the engineering skills (`to-issues`, `triage`, `to-prd`, `qa`, …) live as markdown files in `.scratch/` (gitignored — local working state, same posture as `HANDOFF.md`).

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md`
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Coexistence with kobe's own trackers

This repo has two other tracking surfaces that this file does NOT replace:

- **Daemon issue store** (`kobe api issue-*`, web Issues page) — the product backlog, per [`../WORK-TRACKING.md`](../WORK-TRACKING.md). Long-lived "we should do X" items still belong there.
- **GitHub Issues** — inbound end-user bug reports only (e.g. #192). Never file agent work items there automatically.

`.scratch/` is the working layer for skill-driven feature flows (PRD → issues → QA within a session/feature). When a `.scratch` issue graduates into durable backlog, move it to the daemon store.
