---
name: changelog-generator
description: Generate kobe CHANGELOG entries from git history. Drafts user-facing release notes for `packages/kobe/CHANGELOG.md` under `## [Unreleased]`. Use when the user asks for "changelog", "release notes", "what changed since last release", or before cutting a new version tag. Enforces kobe's no-soft-wrap rule so GitHub release pages render flowing text.
metadata:
  internal: true
---

<!--
Source (originally): https://github.com/ComposioHQ/awesome-claude-skills/blob/master/changelog-generator/SKILL.md
Vendored + heavily kobe-overridden: the upstream version's example output uses soft-wrapped bullets, which break GitHub's release-body rendering (KOB-13). The kobe section below takes precedence over anything generic.
-->

# Changelog Generator (kobe)

Drafts entries for [`packages/kobe/CHANGELOG.md`](../../../packages/kobe/CHANGELOG.md) by reading git history, mapping commits to user-facing categories, and writing them in kobe's house style.

## When to use

- The user says "draft changelog", "write release notes", "what changed since v0.X.Y", or similar.
- Before cutting a release tag — the workflow at `.github/workflows/release.yml` extracts the matching `## [X.Y.Z]` section and uses it as the GitHub release body.
- After a batch of merges where the `## [Unreleased]` section got behind reality.

## kobe project conventions (load-bearing)

Every rule in this section overrides the generic guidance further down.

### File + section format

- Target file: `packages/kobe/CHANGELOG.md` (NOT a top-level `CHANGELOG.md`).
- Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
- New work goes under `## [Unreleased]` until the release-cut moment, when the heading gets renamed to `## [X.Y.Z] - YYYY-MM-DD` and a fresh empty `## [Unreleased]` is added above it.
- Categories used in kobe (in this order, omit empty ones): `### Added`, `### Changed`, `### Fixed`, `### Distribution / Devx`, `### Known limitations`. Free-form `### Why <topic>` paragraphs are allowed for design-decision callouts (see `[0.2.2]` for the canonical example).

### **HARD RULE — no soft wraps**

Every bullet, every paragraph, every numbered-list item must be on a **single line**. Do not wrap at column 70/80/whatever. The line can be 400 chars long; that's fine.

**Why:** GitHub renders release bodies with GFM's hard-break extension. Each newline inside a list item or paragraph becomes a `<br>` tag. Soft-wrapped bullets render as a narrow column with text broken every ~70 chars on the live release page, which looks broken (KOB-13).

If you need a real line break inside a bullet, use a `\` at line end (markdown backslash-break) — but you almost never do; restructure as multiple bullets or paragraphs instead.

### Voice

- Present tense, user-perspective. "Add X", "Fix Y", "Move Z" — not "Added X", not "I added X".
- Lead each bullet with what changed, not why. The why goes in a follow-up clause if it's non-obvious.
- Short bold lead-in for headlines (`- **The thing** — explanation...`) is the established pattern; use it for the first ~3 bullets in each section, plain bullets for the rest.
- Reference internal anchors with backticks (\`task.new\`, \`ctrl+,\`, \`packages/kobe/src/foo.ts\`) rather than prose ("the new task chord", "settings shortcut").
- When citing a Linear issue, write `KOB-N` inline (the GitHub release page auto-links via Linear's GitHub integration).

### Filtering

Pull in: features, behavior changes the user can see/feel, bug fixes affecting user-visible behavior, distribution / packaging / install changes.

Skip: pure refactors, internal test additions (UNLESS they're a milestone like Stream 0.4's harness), CLAUDE.md / docs / skills / memory / agent-config tweaks, dependency bumps with no behavior delta, CI tweaks (unless they're a new gate the user cares about — see 0.1.1).

When in doubt, ask "would a kobe user reading this on github.com/Sma1lboy/kobe/releases care?" If no → skip.

## How to draft

1. Read the latest `## [<version>] - <date>` heading in `packages/kobe/CHANGELOG.md` to find the cut point.
2. Run `git log --no-merges <last-tag>..HEAD --pretty=format:'%h %s%n%b%n---'` (or equivalent) to get the commit set.
3. Group into categories. Write each as a single-line bullet per the rules above. Compress trivial commits, expand commits that hide multiple user-visible deltas.
4. Slot the new bullets under `## [Unreleased]` (DO NOT make a new dated section unless the user explicitly asks for a release cut).
5. Surface the diff and ask the user to skim before they commit.

## Example output (kobe style — single-line bullets)

```markdown
## [Unreleased]

### Added

- **Settings → Dev → Reset clears tasks.json too** (KOB-12). Previously the reset wiped only the KV store and the in-memory Solid signals immediately repopulated it; now reset wipes both `~/.config/kobe/state.json` and `~/.kobe/tasks.json`, then quits kobe so relaunch starts on a clean slate. Worktrees on disk and Claude Code session JSONLs are deliberately not touched.
- **`bypassPermissions` mode reachable from `shift+tab`**. Cycle order is now default → acceptEdits → plan → bypass → default. Bypass passes `--permission-mode bypassPermissions` to claude-code, skipping every tool-permission gate including the worktree-cwd boundary. Footer badge renders in warning color.

### Fixed

- **Pane focus blurs the chat composer reliably.** `ctrl+q` and any `ctrl+hjkl` pane jump now route through a unified `setFocused` that explicitly blurs the renderer's currently-focused renderable before flipping the pane signal. Previously a one-tick window left the textarea owning native input focus, so the new pane ate the next keystroke.
```

Note: every bullet is one long line. No newlines inside bullets. That's the only reliable way to make the GitHub release page render flowing text.

## What to avoid

- ❌ Soft-wrapping a bullet at column 70 because "it looks nicer in the editor". Render-time soft-wrap exists for a reason — let it do its job.
- ❌ Bullets like "Refactor X to use Y pattern" — internal change, skip.
- ❌ Auto-generating from `git log` without filtering. Most commits are noise.
- ❌ Writing dated section headings yourself before the user has decided to cut a version. Stay in `## [Unreleased]`.
- ❌ Touching the version number in `package.json` from inside this skill. The release-cut step is separate.
