# Releasing Rove

Rove versioning + changelog are managed with [Changesets](https://github.com/changesets/changesets). The canonical package is `@sma1lboy/rove` (`packages/kobe`); the release job republishes that exact build as `@sma1lboy/kobe` for existing installs. `packages/branding` is `private` and never published.

## The flow

### 1. While working — add a changeset per user-facing change

When you land a change that affects what the published package *does* (a feature, fix, or behaviour change), record it as a changeset:

```bash
bun run changeset
```

This prompts for the bump type (**patch** / **minor** / **major**) and a summary, then writes a `.changeset/<random-name>.md` file. **Commit that file with your change.** Because each change is its own file, two parallel branches never collide on `CHANGELOG.md` the way appending to a shared `[Unreleased]` section did.

- The summary is the **user-facing changelog line** — write it in product voice, present tense ("Add X", "Fix Y", or a short narrative). It lands verbatim under the next release.
- A pure tooling / docs / CI change that doesn't touch the published package needs **no** changeset. If you want to record "intentionally nothing to release", run `bun run changeset -- --empty`.
- Bump type: default to `patch` for every change, including features and pre-1.0 breaking changes. Use `minor` or `major` only when the maintainer explicitly requests that bump for the change being released.
- The frontmatter must name a **publishable workspace package** — today `"@sma1lboy/rove"` or `"@sma1lboy/rove-plugin-sdk"`. The `@sma1lboy/kobe` names are compatibility aliases that still publish alongside, but a changeset must not version them (they were canonical before 2026-08-13, so stale examples are all over the git history — don't copy an old changeset).

Validate before committing:

```bash
bun run changeset:check         # all pending changesets
bun run hooks:install           # once per clone — runs the same check on commit
```

Worth the two seconds: a bad package name is only caught downstream, by `package-distribution.test.ts` inside `typecheck-and-test`. Once it merges, **main and every branch cut from it stay red** until someone retargets that line (PR #445, 2026-08-15). The pre-commit hook exists to move that discovery from "everyone else's CI" to "your keyboard".

### 2. Cutting a release — automatic (default)

Releases are fully automatic via [`changesets.yml`](../.github/workflows/changesets.yml): **any push to `main` that carries pending changesets IS a release.** No bot PR, no button. The workflow:

1. Waits for the triggering commit's `ci.yml` run to go green (a red run releases nothing — land the fix, and the next push releases the accumulated changesets; a run cancelled by a newer push defers to that push's workflow).
2. Runs the same regeneration `release.sh` does (`changeset version` + lockfile refresh + lint:fix), verifies with `bun install --frozen-lockfile` + the lint gate, commits `chore: release — X.Y.Z`, pushes it, and tags `vX.Y.Z`.
3. Dispatches `release.yml` on the tag (a GITHUB_TOKEN tag push never fires tag triggers — the dispatch is explicit), which re-runs every publish gate from the tag checkout before `npm publish`.

Consequence to keep in mind: a `minor`/`major` changeset auto-ships that bump the moment it lands on `main` — the changeset file in the PR **is** the release decision, so review bump types at PR review time.

### 2b. Cutting a release by hand (fallback)

```bash
scripts/release.sh
```

Same pipeline driven locally — useful when Actions is down or you want the interactive confirm. Don't run it while the bot's `tag` job is mid-flight on the same version (both would race to push the same tag; harmless when identical, noisy when not).

> **PR-only exception.** Development lands on `main` exclusively via pull
> requests (AGENTS.md "PR-only mainline"); the `chore: release — X.Y.Z`
> commit + tag that `release.sh` pushes is the ONE sanctioned direct push —
> it only consumes changesets that already passed PR CI.

This first runs the release gate — lint, typecheck, unit tests, build, and the **behavior** suite — and aborts before touching anything if it fails. The gate deliberately mirrors everything `release.yml` makes `publish` wait on: a check that only ran in CI would be discovered by the *tag*, and a tag that fails to publish burns its version number for good (v0.8.58 did exactly this — green locally, then the pipeline's behavior job failed). If a gate is added to `release.yml`, add it here too. The local gate is a fast-fail, **not the verdict**: it runs on the operator's macOS while CI publishes from ubuntu, and a platform-dependent red (v0.8.66 — a darwin-only code path's test) only shows up on CI. That's why tagging is two-phase (below).

With a green gate, it consumes every pending `.changeset/*.md`:

1. `changeset version` — computes the next version from the pending bump types, rewrites `packages/kobe/package.json`, and prepends the collected notes to `CHANGELOG.md` (then deletes the consumed changesets).
2. Runs `bun install`, then `bun install --frozen-lockfile`, so `bun.lock` matches the workspace package versions before the release commit is made.
3. Re-runs Biome `--write` on the touched `package.json` / `CHANGELOG.md` so the generated JSON formatting can't fail the lint gate (Changesets and the release script both reserialize `package.json`, which used to re-expand the single-line `files` array). This step is no longer error-swallowed — a `lint:fix` failure stops the release.
4. Commits `chore: release — X.Y.Z`. **No tag yet.**
5. (After confirming) pushes the release commit to `main`, then **waits for that commit's `ci.yml` run** — typecheck-and-test, behavior, render-track, visual-ground-truth on real CI hardware, the same set `release.yml` makes `publish` wait on. Only when it's green does the script tag `vX.Y.Z` and push the tag.

If CI comes back red, **no tag exists and the version number is not burned**: `package.json` on `main` already carries X.Y.Z, so land the fix on `main` (no new changeset needed) and re-run `scripts/release.sh` — with zero pending changesets and an untagged committed version it enters **resume mode**: waits for CI at the fixed HEAD, then tags the same `vX.Y.Z` there. The same resume path covers answering `N` at the push prompt and a CI run cancelled by a newer main push.

The push triggers `.github/workflows/release.yml`, which gates on **lint + typecheck + unit tests (fast + socket) + build**, waits on the same **behavior** suite `ci.yml`'s PR gate runs, publishes `@sma1lboy/rove`, then publishes the same files/version/bins as the `@sma1lboy/kobe` compatibility alias and extracts the new `CHANGELOG.md` section as the GitHub release body. Both publish steps are idempotent so a rerun can finish a partially published pair. npm is the sole distribution channel — standalone binaries were dropped 2026-08-02 (nothing consumed them; `packages/kobe/scripts/compile.ts` still builds one locally on demand). The same publish job also piggyback-publishes **`@sma1lboy/rove-plugin-sdk`** whenever its independently changeset-versioned version isn't on npm yet, then republishes the identical artifact as the **`@sma1lboy/kobe-plugin-sdk`** compatibility alias. The SDK has no tag of its own; an SDK-only release still rides the next Rove release.

## Style rule — no soft wraps inside bullets or paragraphs

GitHub renders release bodies with GFM's hard-break extension: every single newline inside a list item or paragraph becomes a `<br>`, which makes the release page look like a narrow column broken every ~70 chars. **Write each changeset bullet (and each paragraph) as one long line.** Editors can soft-wrap at display time. KOB-13 has the rationale; the [`changelog-generator`](../.claude/skills/changelog-generator/SKILL.md) skill knows this rule.

## Breaking releases — the reset gate

A release whose state/daemon/session format is incompatible with older installs must be added to `BREAKING_VERSIONS` in [`packages/kobe/src/version.ts`](../packages/kobe/src/version.ts) **in the same PR that ships the break** (the version you add is the one about to be released — confirm it against the pending changesets' bump). The changeset summary must say what breaks and that `rove reset` is required.

What the list drives:

- **Boot gate** (`src/cli/reset-gate.ts`): `state.json` remembers the last version that ran; when a launch crosses a `BREAKING_VERSIONS` entry (upgrade *or* downgrade), the TUI/web entrances refuse to start and print the `rove reset` instructions. A completed `rove reset` re-stamps the gate.
- **`rove update` warning**: installing a target across a breaking version prints a heads-up before the script runs; `rove update --list` marks breaking versions.

Worktrees are never part of a reset — the gate's cost to the user is daemon/session teardown (plus the task index only if they choose `--hard`).

## Prereleases

A prerelease tag (`v0.7.0-experimental.0`) publishes to an npm dist-tag named after the prerelease identifier (`experimental`), so `latest` stays on the stable line while testers opt in with `npm i @sma1lboy/rove@experimental`. The matching `@sma1lboy/kobe@experimental` alias is published in lockstep. Use Changesets' [prerelease mode](https://github.com/changesets/changesets/blob/main/docs/prereleases.md) (`changeset pre enter experimental` … `changeset pre exit`) to generate those versions.
