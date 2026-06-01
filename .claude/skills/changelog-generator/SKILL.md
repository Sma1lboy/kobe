---
name: changelog-generator
description: Draft kobe release notes as Changesets. Writes user-facing entries as `.changeset/*.md` files for `@sma1lboy/kobe` (consumed into `packages/kobe/CHANGELOG.md` at release time). Use when the user asks for "changelog", "release notes", "what changed", "add a changeset", or before cutting a version. Enforces kobe's no-soft-wrap rule so GitHub release pages render flowing text.
metadata:
  internal: true
---

<!--
Source (originally): https://github.com/ComposioHQ/awesome-claude-skills/blob/master/changelog-generator/SKILL.md
Vendored + heavily kobe-overridden. As of the Changesets migration (docs/RELEASING.md) kobe no longer hand-edits a `## [Unreleased]` section — pending notes live as `.changeset/*.md` files and `changeset version` generates the CHANGELOG at release time. The kobe section below takes precedence over anything generic.
-->

# Changelog Generator (kobe)

Drafts release notes as **Changesets** — one `.changeset/<name>.md` file per change — in kobe's house style. `scripts/release.sh` (via `changeset version`) later consumes them into [`packages/kobe/CHANGELOG.md`](../../../packages/kobe/CHANGELOG.md) and the GitHub release body. See [`docs/RELEASING.md`](../../../docs/RELEASING.md) for the full flow.

## When to use

- The user says "draft changelog", "write release notes", "add a changeset", "what changed since v0.X.Y", or similar.
- After landing a user-facing change that has no changeset yet (e.g. it was committed before this skill existed, or in a batch that skipped them).
- Before cutting a release tag — to backfill changesets for anything user-facing that slipped through, so the generated notes are complete.

## kobe project conventions (load-bearing)

Every rule in this section overrides the generic guidance further down.

### File format — a changeset, not a CHANGELOG edit

- Do **not** hand-edit `packages/kobe/CHANGELOG.md` or invent a `## [Unreleased]` section — that file is generated.
- Each change is a new file `.changeset/<two-words-random>.md` (the `changeset` CLI names it; if writing by hand, any unique kebab name works). Shape:

  ```markdown
  ---
  "@sma1lboy/kobe": minor
  ---

  Single-line user-facing summary. This text lands verbatim under the next release and in the GitHub release body.
  ```

- The frontmatter bump key is the **only** package, `@sma1lboy/kobe`, with value `patch` | `minor` | `major`:
  - `patch` — bug fix or small behaviour tweak.
  - `minor` — a new feature or user-visible capability.
  - `major` — a breaking change. kobe is pre-1.0, so prefer `minor` for breaking changes unless the user says otherwise.
- The bump type *is* the category — Changesets groups output under `### Minor Changes` / `### Patch Changes` automatically. Don't write `### Added`/`### Fixed` headings yourself.
- One changeset per coherent change. A batch that did three user-visible things → three changesets (or one with three bullets if they're one feature). Prefer the `changeset` CLI: `bun run changeset` (interactive) writes the file for you.

### **HARD RULE — no soft wraps**

Every bullet, every paragraph in a changeset body must be on a **single line**. Do not wrap at column 70/80/whatever. The line can be 400 chars long; that's fine.

**Why:** GitHub renders release bodies with GFM's hard-break extension. Each newline inside a list item or paragraph becomes a `<br>` tag. Soft-wrapped text renders as a narrow column broken every ~70 chars on the live release page, which looks broken (KOB-13).

### Voice

- Present tense, user-perspective. "Add X", "Fix Y", "Move Z" — not "Added X", not "I added X".
- Lead with what changed, not why. The why goes in a follow-up clause if it's non-obvious.
- Short bold lead-in for headlines (`**The thing** — explanation...`) is the established pattern.
- Reference internal anchors with backticks (\`task.new\`, \`ctrl+,\`, \`packages/kobe/src/foo.ts\`) rather than prose.
- When citing a Linear issue, write `KOB-N` inline (the GitHub release page auto-links via Linear's GitHub integration).

### Filtering

Pull in: features, behaviour changes the user can see/feel, bug fixes affecting user-visible behaviour, distribution / packaging / install changes.

Skip: pure refactors, internal test additions (UNLESS a milestone), CLAUDE.md / docs / skills / memory / agent-config tweaks, dependency bumps with no behaviour delta, CI tweaks (unless a new gate the user cares about). A change that needs no release can still record that explicitly with `bun run changeset -- --empty`.

When in doubt, ask "would a kobe user reading this on github.com/Sma1lboy/kobe/releases care?" If no → skip (or empty changeset).

## How to draft

1. Find the cut point: the latest `## [<version>]` heading in `packages/kobe/CHANGELOG.md`, or the last `v*` tag.
2. Run `git log --no-merges <last-tag>..HEAD --pretty=format:'%h %s%n%b%n---'` to get the commit set, and check `.changeset/*.md` for changes that already have one (don't duplicate).
3. Group the *un-covered* user-facing changes. Write one changeset file per coherent change, each with the right bump type and a single-line summary per the rules above.
4. Prefer `bun run changeset` so the CLI writes the file; only hand-author the `.changeset/<name>.md` if scripting a batch.
5. Surface the new changeset file(s) and ask the user to skim before committing them.

## Example output (a changeset file)

`.changeset/swift-pandas-cheer.md`:

```markdown
---
"@sma1lboy/kobe": minor
---

**The Tasks pane fills its tmux pane and adapts to its width** — the task list now stretches to 100% of the pane as you drag the tmux split. On a narrow pane the secondary columns step aside so the task name stays readable: the branch label drops first, then the changes chip, and the title ellipsises only when it must.
```

Note: the summary is one long line. No newlines inside it. That's the only reliable way to make the GitHub release page render flowing text.

## What to avoid

- ❌ Hand-editing `packages/kobe/CHANGELOG.md` or recreating a `## [Unreleased]` section — it's generated from changesets now.
- ❌ Soft-wrapping a changeset summary at column 70 because "it looks nicer in the editor". Render-time soft-wrap exists for a reason.
- ❌ Changesets like "Refactor X to use Y pattern" — internal change, skip (or `--empty`).
- ❌ Auto-generating from `git log` without filtering. Most commits are noise.
- ❌ Touching the version number in `package.json` — `changeset version` (run by `scripts/release.sh`) owns that.
