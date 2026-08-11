#!/usr/bin/env bash
# Cut a kobe release from pending changesets.
#
# Usage:
#   scripts/release.sh        # consume .changeset/*.md → version + CHANGELOG → commit + tag + push
#
# The bump (patch/minor/major) is NOT passed here — it comes from the pending
# changeset files. Add changesets while you work with `bun run changeset`; see
# docs/RELEASING.md.
#
# What it does:
#   0. Verify local main == origin/main. A release publishes what CI builds
#      from the pushed tag, so unpushed commits (never PR-reviewed) and a
#      stale local tree are both refused. Unrelated UNCOMMITTED files are
#      only reported — they can't reach the tag, and blocking on them froze
#      releases whenever another session had work in progress.
#   1. Gate: lint, typecheck, test, build, behavior — the same set
#      `release.yml` makes `publish` wait on, so a gate the tag would fail on
#      fails HERE instead, while the version number is still reusable. Any
#      failure aborts before touching version/CHANGELOG — a red tree never
#      gets tagged. Runs against the working tree as a fast fail; `release.yml`
#      re-runs everything from the tag checkout before publishing.
#   2. `changeset version` — derives the next version from pending changesets,
#      rewrites packages/kobe/package.json, prepends notes to CHANGELOG.md, and
#      deletes the consumed changesets.
#   3. `bun install` — refreshes bun.lock after the package version changed,
#      then `bun install --frozen-lockfile` verifies the lockfile is complete.
#   4. Biome `--write` on the regenerated package.json / CHANGELOG.md so the
#      reserialized JSON can't fail the lint gate (the `files` array used to
#      re-expand to multi-line and break `biome check`).
#   5. Commits "chore: release — X.Y.Z". The tag is NOT created yet.
#   6. Asks, then pushes the release COMMIT to main and waits for its CI run
#      (ci.yml on ubuntu/macos — the same job set release.yml makes `publish`
#      wait on) to go green. Only THEN tags vX.Y.Z and pushes the tag, which
#      triggers the publish. Local gates run on this (macOS) machine, so a
#      Linux-only red reaches CI first — under the old order that red arrived
#      AFTER the tag and burned the version number (v0.8.58, v0.8.66). Now a
#      red release commit leaves no tag: land the fix on main and re-run this
#      script — it detects the committed-but-untagged version and RESUMES
#      (wait for CI at the fixed HEAD → tag the same vX.Y.Z → push).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="$REPO_ROOT/packages/kobe/package.json"
CHANGELOG="$REPO_ROOT/packages/kobe/CHANGELOG.md"
cd "$REPO_ROOT"

# ── two-phase tag: wait for the release commit's CI, then tag + push ─────────
# The tag is what publishes, and the version number it carries is single-use.
# So the tag only gets created after the release COMMIT is green on GitHub CI
# (ubuntu + macos), which the local gate on this machine cannot prove
# (platform-dependent reds: v0.8.66's darwin-only test path). ci.yml's
# main-push jobs (typecheck-and-test, behavior, render-track,
# visual-ground-truth) are the same set release.yml makes `publish` wait on.
await_ci_then_tag() {
  local version="$1" tag="v$1" sha run_id="" tries=0 concl
  sha=$(git rev-parse HEAD)
  echo "Waiting for CI on ${sha:0:9} (the same Linux/macOS gates that block publish)…"
  while [ -z "$run_id" ]; do
    tries=$((tries + 1))
    if [ "$tries" -gt 36 ]; then
      echo "Error: no ci.yml run appeared for $sha within ~3min. Check gh auth / Actions." >&2
      return 1
    fi
    sleep 5
    run_id=$(gh run list --workflow=ci.yml --branch main --limit 15 --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"$sha\") | .databaseId" | head -1)
  done
  echo "  ci.yml run $run_id — watching to completion…"
  if ! gh run watch "$run_id" --exit-status >/dev/null; then
    concl=$(gh run view "$run_id" --json conclusion --jq .conclusion)
    if [ "$concl" = "cancelled" ]; then
      echo "CI run was CANCELLED (a newer main push superseded it — ci.yml cancels in-progress runs)." >&2
      echo "Nothing was tagged. Pull main and re-run scripts/release.sh to resume $tag." >&2
    else
      echo "CI FAILED on the release commit. NO tag was pushed — $version is NOT burned." >&2
      echo "  Logs:   gh run view $run_id --log-failed" >&2
      echo "  Recover: land the fix on main, re-run scripts/release.sh — it resumes and" >&2
      echo "           tags $tag at the fixed HEAD (package.json still carries $version)." >&2
    fi
    return 1
  fi
  echo "✓  CI green on the release commit"
  if git rev-parse "$tag" &>/dev/null; then
    if [ "$(git rev-parse "$tag^{commit}")" != "$sha" ]; then
      echo "Error: local tag $tag exists but points elsewhere — resolve manually." >&2
      return 1
    fi
  else
    git tag "$tag"
  fi
  git push origin "$tag"
  echo ""
  echo "✓  Tagged + pushed $tag — publish is running:"
  echo "   https://github.com/sma1lboy/kobe/actions"
}

# ── safety: there must be pending changesets to release ───────────────────────
PENDING=$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' 2>/dev/null | wc -l | tr -d ' ')
if [ "$PENDING" = "0" ]; then
  # Committed-but-untagged version ⇒ an interrupted two-phase release (CI was
  # red or the wait was cancelled). Resume it instead of demanding changesets.
  CURRENT=$(node -p "require('$PKG_JSON').version")
  if ! git ls-remote --tags origin "refs/tags/v$CURRENT" | grep -q .; then
    echo "No pending changesets, but v$CURRENT is committed and NOT tagged on origin."
    echo "Resuming the interrupted release of $CURRENT…"
    git fetch origin main --quiet
    if [ "$(git rev-list --count HEAD..origin/main)" != "0" ]; then
      echo "Error: local main is BEHIND origin/main — pull first, then re-run." >&2
      exit 1
    fi
    read -rp "Wait for CI on HEAD, then tag + push v$CURRENT? [y/N] " REPLY
    [[ "$REPLY" =~ ^[Yy]$ ]] || exit 0
    # Ahead-only (release commit answered N to the push, or a fix landed
    # locally): push main first so CI runs on what will be tagged.
    if [ "$(git rev-list --count origin/main..HEAD)" != "0" ]; then
      git push origin main
    fi
    await_ci_then_tag "$CURRENT"
    exit $?
  fi
  echo "No pending changesets in .changeset/ — nothing to release." >&2
  echo "Add one with: bun run changeset" >&2
  exit 1
fi

# ── report (don't block on) unrelated uncommitted work ────────────────────────
# What ships is the TAG, and the tag is built from committed content: the
# release commit stages an explicit path list (see `git add` below) and CI
# publishes from a fresh checkout of the tag. So a file someone else is
# mid-edit on cannot reach npm — and blocking here meant one agent's
# work-in-progress froze releases for everyone else on a fast-moving repo
# where several sessions share the checkout.
#
# Still WORTH SAYING OUT LOUD, because the gate below runs against the
# working tree: uncommitted edits can turn the local lint/typecheck/test
# result green or red in ways the tag's own content wouldn't. That's a
# fast-fail convenience, not the verdict — `release.yml` re-runs every gate
# from the tag checkout before it publishes.
DIRTY=$(git diff --name-only HEAD \
  | grep -v '^packages/kobe/package\.json$' \
  | grep -v '^packages/kobe/CHANGELOG\.md$' \
  | grep -v '^bun\.lock$' \
  | grep -v '^\.changeset/' || true)
if [ -n "$DIRTY" ]; then
  echo "Note: uncommitted changes present (NOT part of this release):" >&2
  echo "$DIRTY" | sed 's/^/  /' >&2
  echo "" >&2
  echo "  The release commit stages an explicit path list and CI publishes from" >&2
  echo "  the tag, so these stay local. The gate below does run against them." >&2
  echo "" >&2
fi

# ── safety: release from origin/main, not a local divergence ─────────────────
# The release is a REMOTE artifact: CI builds from the pushed tag, and npm
# gets whatever `origin/main` held. So local HEAD must already BE origin/main
# — a local-only commit would be published without ever having passed PR CI,
# and being behind means tagging a stale tree that clobbers nothing locally
# but ships an old build. Neither is auto-fixable here (pull vs rebase vs
# "that commit shouldn't ship" is a judgment call), so both stop.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "Error: releases cut from main only (on '$BRANCH')." >&2
  exit 1
fi
git fetch origin main --quiet
AHEAD=$(git rev-list --count origin/main..HEAD)
BEHIND=$(git rev-list --count HEAD..origin/main)
if [ "$BEHIND" != "0" ]; then
  echo "Error: local main is $BEHIND commit(s) BEHIND origin/main." >&2
  echo "  Tagging here would ship a stale tree. Pull first." >&2
  exit 1
fi
if [ "$AHEAD" != "0" ]; then
  echo "Error: local main is $AHEAD commit(s) AHEAD of origin/main:" >&2
  git log --oneline origin/main..HEAD | sed 's/^/  /' >&2
  echo "" >&2
  echo "  A release publishes what is on origin/main. Push these first (they" >&2
  echo "  then go through CI), or drop them — don't publish unpushed work." >&2
  exit 1
fi

CURRENT=$(node -p "require('$PKG_JSON').version")

# ── gate: lint + typecheck + test + build + behavior ──────────────────────────
# Fail here, not after `changeset version` — a red tree must never get a
# version bump, commit, or tag written for it.
#
# The gate must mirror what `release.yml` makes `publish` WAIT ON, or the
# tag is the thing that discovers the failure. v0.8.58 burned exactly that
# way: lint/typecheck/test were green locally, the tag pushed, and the
# release pipeline's `behavior` job (never run locally) failed — leaving a
# published-nothing tag on a version number that can't be reused.
echo "Running release gate (lint, typecheck, test, build, behavior)…"
bun run lint
bun run typecheck
(cd packages/kobe && bun run test)
bun run build
# node-pty is optional locally (the suite self-skips without it); on CI it is
# present and this is the same command the release pipeline runs.
bun run --filter @sma1lboy/kobe test:behavior

# ── consume changesets → bump version + write CHANGELOG ───────────────────────
bun x changeset version

NEW_VERSION=$(node -p "require('$PKG_JSON').version")
if [ "$NEW_VERSION" = "$CURRENT" ]; then
  echo "Error: version did not change ($CURRENT). Did the changesets carry a bump?" >&2
  exit 1
fi
TAG="v$NEW_VERSION"

# ── refresh + verify lockfile ────────────────────────────────────────────────
# Changesets updates package versions but does not update Bun's workspace
# lockfile. Refresh it here so the release commit is the exact state CI will
# validate with --frozen-lockfile.
bun install
bun install --frozen-lockfile

# ── neutralize the JSON-reserialize lint trap ─────────────────────────────────
# `changeset version` rewrites package.json with its own formatter, which can
# re-expand the single-line `files` array and trip `biome check`. Format the
# files it touched so the lint gate stays green. No error-swallowing: if
# lint:fix itself fails, stop rather than commit+tag an unformatted tree.
bun run lint:fix

echo "──────────────────────────────────────────"
echo "  kobe $CURRENT  →  $NEW_VERSION  ($TAG)"
echo "──────────────────────────────────────────"

# ── safety: tag must not already exist ────────────────────────────────────────
if git rev-parse "$TAG" &>/dev/null 2>&1; then
  echo "Error: tag $TAG already exists — delete it first if you want to retag." >&2
  exit 1
fi

# ── show what's in the release section ────────────────────────────────────────
NOTES=$(awk -v ver="$NEW_VERSION" '
  $0 ~ "^## \\[?" ver "([]). -]|$)" { found=1; next }
  found && /^## / { exit }
  found { print }
' "$CHANGELOG")
echo ""
echo "  Release notes:"
echo "$NOTES" | sed 's/^/    /'
echo ""

# ── commit & tag ──────────────────────────────────────────────────────────────
# `changeset version` rewrites EVERY bumped workspace package (kobe, the
# plugin SDK, private internals like kobe-daemon/kobe-web get dependency
# bumps too) — stage them all. Staging only packages/kobe once tagged a
# commit that pinned kobe to a daemon version that existed nowhere (0.8.30).
git add packages/*/package.json packages/*/CHANGELOG.md .changeset
if ! git diff --quiet bun.lock 2>/dev/null; then
  git add bun.lock
fi
git commit -m "chore: release — $NEW_VERSION"
echo "✓  Committed $NEW_VERSION — the tag comes only after CI validates this commit"

# ── push commit → await CI → tag ─────────────────────────────────────────────
echo ""
echo "Ready to push the release commit → wait for its CI (ubuntu+macos) →"
echo "then tag $TAG, which triggers:"
echo "  • npm publish @sma1lboy/kobe@$NEW_VERSION"
echo "  • GitHub release with the notes above"
echo ""
read -rp "Push now? [y/N] " REPLY
if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  git push origin main
  await_ci_then_tag "$NEW_VERSION"
else
  echo ""
  echo "Not pushed. When ready, re-run scripts/release.sh — it will resume"
  echo "(push is already committed; it waits for CI, then tags $TAG)."
fi
