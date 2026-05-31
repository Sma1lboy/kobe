#!/usr/bin/env bash
# Cut a kobe release: bump version, update CHANGELOG, commit, tag, push.
#
# Usage:
#   scripts/release.sh          # patch bump (0.6.7 → 0.6.8)
#   scripts/release.sh minor    # minor bump (0.6.7 → 0.7.0)
#   scripts/release.sh major    # major bump (0.6.7 → 1.0.0)
#   scripts/release.sh 0.7.1    # explicit version
#
# What it does:
#   1. Bumps packages/kobe/package.json version
#   2. Renames [Unreleased] → [X.Y.Z] + inserts fresh [Unreleased] in CHANGELOG
#   3. Commits both files as "chore: release — X.Y.Z"
#   4. Creates tag vX.Y.Z
#   5. Asks before pushing (main + tag) — the push triggers GitHub Actions
#      which typechecks, tests, builds, publishes to npm, and creates the
#      GitHub release with the extracted CHANGELOG notes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="$REPO_ROOT/packages/kobe/package.json"
CHANGELOG="$REPO_ROOT/packages/kobe/CHANGELOG.md"

# ── current version ───────────────────────────────────────────────────────────
CURRENT=$(python3 -c "import json; print(json.load(open('$PKG_JSON'))['version'])")
BUMP="${1:-patch}"

# ── compute new version ───────────────────────────────────────────────────────
case "$BUMP" in
  major|minor|patch)
    IFS='.' read -r maj min pat <<< "$CURRENT"
    case "$BUMP" in
      major) NEW_VERSION="$((maj+1)).0.0" ;;
      minor) NEW_VERSION="${maj}.$((min+1)).0" ;;
      patch) NEW_VERSION="${maj}.${min}.$((pat+1))" ;;
    esac
    ;;
  [0-9]*)
    NEW_VERSION="$BUMP"
    ;;
  *)
    echo "Usage: $0 [patch|minor|major|X.Y.Z]" >&2
    exit 1
    ;;
esac

TAG="v$NEW_VERSION"
TODAY=$(date +%Y-%m-%d)

echo "──────────────────────────────────────────"
echo "  kobe $CURRENT  →  $NEW_VERSION  ($TAG)"
echo "──────────────────────────────────────────"

# ── safety: tag must not already exist ────────────────────────────────────────
cd "$REPO_ROOT"
if git rev-parse "$TAG" &>/dev/null 2>&1; then
  echo "Error: tag $TAG already exists — delete it first if you want to retag." >&2
  exit 1
fi

# ── safety: working tree must be clean (except staged/unstaged pkg files) ─────
DIRTY=$(git diff --name-only HEAD | grep -v '^packages/kobe/package\.json$' | grep -v '^packages/kobe/CHANGELOG\.md$' | grep -v '^bun\.lock$' || true)
if [ -n "$DIRTY" ]; then
  echo "Uncommitted changes in:" >&2
  echo "$DIRTY" | sed 's/^/  /' >&2
  echo "" >&2
  echo "Commit or stash them before releasing." >&2
  exit 1
fi

# ── bump package.json ─────────────────────────────────────────────────────────
python3 - "$PKG_JSON" "$NEW_VERSION" << 'PYEOF'
import json, sys
path, ver = sys.argv[1], sys.argv[2]
with open(path) as f:
    pkg = json.load(f)
pkg["version"] = ver
with open(path, "w") as f:
    json.dump(pkg, f, indent=2)
    f.write("\n")
PYEOF
echo "✓  package.json → $NEW_VERSION"

# ── update CHANGELOG ──────────────────────────────────────────────────────────
# Use ^## \[Unreleased\] (MULTILINE) to match only a line-start header,
# not the same text appearing inside backtick spans in the "How to update"
# preamble section.
python3 - "$CHANGELOG" "$NEW_VERSION" "$TODAY" << 'PYEOF'
import re, sys
path, ver, today = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    content = f.read()
marker_re = re.compile(r'^## \[Unreleased\]', re.MULTILINE)
if not marker_re.search(content):
    print("Error: '## [Unreleased]' header not found at line start in CHANGELOG.md", file=sys.stderr)
    sys.exit(1)
replacement = f"## [Unreleased]\n\n## [{ver}] - {today}"
with open(path, "w") as f:
    f.write(marker_re.sub(replacement, content, count=1))
PYEOF
echo "✓  CHANGELOG.md  [Unreleased] → [$NEW_VERSION] - $TODAY"

# ── show what's in the release section ────────────────────────────────────────
# Use MULTILINE so ^ anchors match line starts, not just the string start.
NOTES=$(python3 - "$CHANGELOG" "$NEW_VERSION" << 'PYEOF'
import re, sys
path, ver = sys.argv[1], sys.argv[2]
content = open(path).read()
m = re.search(
    rf'^## \[{re.escape(ver)}\][^\n]*\n(.*?)(?=^## \[|\Z)',
    content, re.DOTALL | re.MULTILINE,
)
print(m.group(1).strip() if m else "(empty)")
PYEOF
)
if [ "$NOTES" = "(empty)" ]; then
  echo ""
  echo "  ⚠  The [$NEW_VERSION] CHANGELOG section is empty."
  echo "     Add release notes under [Unreleased] before tagging."
  echo ""
  read -rp "  Continue with empty notes? [y/N] " REPLY
  [[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
else
  echo ""
  echo "  Release notes:"
  echo "$NOTES" | sed 's/^/    /'
  echo ""
fi

# ── commit & tag ──────────────────────────────────────────────────────────────
git add packages/kobe/package.json packages/kobe/CHANGELOG.md
# Include bun.lock only if it was already modified (workspace version bump side-effect)
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
