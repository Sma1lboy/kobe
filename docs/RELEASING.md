# Releasing kobe

kobe versioning + changelog are managed with [Changesets](https://github.com/changesets/changesets). The published package is `@sma1lboy/kobe` (`packages/kobe`); `packages/branding` is private and never published.

## The flow

### 1. While working — add a changeset per user-facing change

When you land a change that affects what the published package *does* (a feature, fix, or behaviour change), record it as a changeset:

```bash
bun run changeset
```

This prompts for the bump type (**patch** / **minor** / **major**) and a summary, then writes a `.changeset/<random-name>.md` file. **Commit that file with your change.** Because each change is its own file, two parallel branches never collide on `CHANGELOG.md` the way appending to a shared `[Unreleased]` section did.

- The summary is the **user-facing changelog line** — write it in product voice, present tense ("Add X", "Fix Y", or a short narrative). It lands verbatim under the next release.
- A pure tooling / docs / CI change that doesn't touch the published package needs **no** changeset. If you want to record "intentionally nothing to release", run `bun run changeset -- --empty`.
- Bump type: `patch` for fixes, `minor` for features, `major` for breaking changes. kobe is pre-1.0, so breaking changes still go `minor` by convention unless we decide otherwise.

### 2. Cutting a release

```bash
scripts/release.sh
```

This consumes every pending `.changeset/*.md`:

1. `changeset version` — computes the next version from the pending bump types, rewrites `packages/kobe/package.json`, and prepends the collected notes to `CHANGELOG.md` (then deletes the consumed changesets).
2. Runs `bun install`, then `bun install --frozen-lockfile`, so `bun.lock` matches the workspace package versions before the release commit is made.
3. Re-runs Biome `--write` on the touched `package.json` / `CHANGELOG.md` so the generated JSON formatting can't fail the lint gate (Changesets and the release script both reserialize `package.json`, which used to re-expand the single-line `files` array).
4. Commits `chore: release — X.Y.Z`, tags `vX.Y.Z`, and (after confirming) pushes `main` + the tag.

The push triggers `.github/workflows/release.yml`, which gates on **typecheck + test + build**, then `npm publish`es, extracts the new `CHANGELOG.md` section as the GitHub release body, and builds the standalone binaries.

> The release workflow's gate does **not** run lint. Run `bun run lint` locally (or rely on the push-triggered `ci.yml`) — a lint regression won't block a publish on its own.

## Style rule — no soft wraps inside bullets or paragraphs

GitHub renders release bodies with GFM's hard-break extension: every single newline inside a list item or paragraph becomes a `<br>`, which makes the release page look like a narrow column broken every ~70 chars. **Write each changeset bullet (and each paragraph) as one long line.** Editors can soft-wrap at display time. KOB-13 has the rationale; the [`changelog-generator`](../.claude/skills/changelog-generator/SKILL.md) skill knows this rule.

## Prereleases

A prerelease tag (`v0.7.0-experimental.0`) publishes to an npm dist-tag named after the prerelease identifier (`experimental`), so `latest` stays on the stable line while testers opt in with `npm i @sma1lboy/kobe@experimental`. Use Changesets' [prerelease mode](https://github.com/changesets/changesets/blob/main/docs/prereleases.md) (`changeset pre enter experimental` … `changeset pre exit`) to generate those versions.
