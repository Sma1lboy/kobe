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
#   1. `changeset version` — derives the next version from pending changesets,
#      rewrites packages/kobe/package.json, prepends notes to CHANGELOG.md, and
#      deletes the consumed changesets.
#   2. Biome `--write` on the regenerated package.json / CHANGELOG.md so the
#      reserialized JSON can't fail the lint gate (the `files` array used to
#      re-expand to multi-line and break `biome check`).
#   3. Commits "chore: release — X.Y.Z", tags vX.Y.Z.
#   4. Asks before pushing (main + tag) — the push triggers GitHub Actions
#      which typechecks, tests, builds, publishes to npm, and creates the
#      GitHub release with the extracted CHANGELOG notes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="$REPO_ROOT/packages/kobe/package.json"
CHANGELOG="$REPO_ROOT/packages/kobe/CHANGELOG.md"
cd "$REPO_ROOT"

# ── safety: there must be pending changesets to release ───────────────────────
PENDING=$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' 2>/dev/null | wc -l | tr -d ' ')
if [ "$PENDING" = "0" ]; then
  echo "No pending changesets in .changeset/ — nothing to release." >&2
  echo "Add one with: bun run changeset" >&2
  exit 1
fi

# ── safety: working tree clean (except files the release itself rewrites) ─────
DIRTY=$(git diff --name-only HEAD \
  | grep -v '^packages/kobe/package\.json$' \
  | grep -v '^packages/kobe/CHANGELOG\.md$' \
  | grep -v '^bun\.lock$' \
  | grep -v '^\.changeset/' || true)
if [ -n "$DIRTY" ]; then
  echo "Uncommitted changes in:" >&2
  echo "$DIRTY" | sed 's/^/  /' >&2
  echo "" >&2
  echo "Commit or stash them before releasing." >&2
  exit 1
fi

CURRENT=$(node -p "require('$PKG_JSON').version")

# ── consume changesets → bump version + write CHANGELOG ───────────────────────
bun x changeset version

NEW_VERSION=$(node -p "require('$PKG_JSON').version")
if [ "$NEW_VERSION" = "$CURRENT" ]; then
  echo "Error: version did not change ($CURRENT). Did the changesets carry a bump?" >&2
  exit 1
fi
TAG="v$NEW_VERSION"

# ── neutralize the JSON-reserialize lint trap ─────────────────────────────────
# `changeset version` rewrites package.json with its own formatter, which can
# re-expand the single-line `files` array and trip `biome check`. Format the
# files it touched so the lint gate stays green.
bun run lint:fix >/dev/null 2>&1 || true

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
git add packages/kobe/package.json packages/kobe/CHANGELOG.md .changeset
if ! git diff --quiet bun.lock 2>/dev/null; then
  git add bun.lock
fi
git commit -m "chore: release — $NEW_VERSION"
git tag "$TAG"
echo "✓  Committed + tagged $TAG"

# ── push ──────────────────────────────────────────────────────────────────────
echo ""
echo "Ready to push main + $TAG → GitHub Actions will:"
echo "  • typecheck + test + build"
echo "  • npm publish @sma1lboy/kobe@$NEW_VERSION"
echo "  • create GitHub release with the notes above"
echo "  • build standalone binaries (darwin-arm64, darwin-x64, linux-x64, linux-arm64)"
echo ""
read -rp "Push now? [y/N] " REPLY
if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  git push origin main "$TAG"
  echo ""
  echo "✓  Pushed — watch CI at:"
  echo "   https://github.com/sma1lboy/kobe/actions"
else
  echo ""
  echo "Not pushed. When ready:"
  echo "  git push origin main $TAG"
fi
