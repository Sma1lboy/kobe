#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="$REPO_ROOT/packages/kobe/package.json"
CHANGELOG="$REPO_ROOT/packages/kobe/CHANGELOG.md"
cd "$REPO_ROOT"

PENDING=$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' 2>/dev/null | wc -l | tr -d ' ')
if [ "$PENDING" = "0" ]; then
  echo "No pending changesets in .changeset/ — nothing to release." >&2
  echo "Add one with: bun run changeset" >&2
  exit 1
fi

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

bun x changeset version

NEW_VERSION=$(node -p "require('$PKG_JSON').version")
if [ "$NEW_VERSION" = "$CURRENT" ]; then
  echo "Error: version did not change ($CURRENT). Did the changesets carry a bump?" >&2
  exit 1
fi
TAG="v$NEW_VERSION"

bun install
bun install --frozen-lockfile

bun run lint:fix >/dev/null 2>&1 || true

echo "──────────────────────────────────────────"
echo "  kobe $CURRENT  →  $NEW_VERSION  ($TAG)"
echo "──────────────────────────────────────────"

if git rev-parse "$TAG" &>/dev/null 2>&1; then
  echo "Error: tag $TAG already exists — delete it first if you want to retag." >&2
  exit 1
fi

NOTES=$(awk -v ver="$NEW_VERSION" '
  $0 ~ "^## \\[?" ver "([]). -]|$)" { found=1; next }
  found && /^## / { exit }
  found { print }
' "$CHANGELOG")
echo ""
echo "  Release notes:"
echo "$NOTES" | sed 's/^/    /'
echo ""

git add packages/kobe/package.json packages/kobe/CHANGELOG.md .changeset
if ! git diff --quiet bun.lock 2>/dev/null; then
  git add bun.lock
fi
git commit -m "chore: release — $NEW_VERSION"
git tag "$TAG"
echo "✓  Committed + tagged $TAG"

echo ""
echo "Ready to push main + $TAG → GitHub Actions will:"
echo "  • typecheck + test + build"
echo "  • npm publish @sma1lboy/kobe@$NEW_VERSION"
echo "  • create GitHub release with the notes above"
echo "  • build standalone binaries (darwin-arm64, linux-x64, linux-arm64)"
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
