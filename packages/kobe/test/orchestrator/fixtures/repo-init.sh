#!/usr/bin/env bash
# Build a minimal git repo at $1 for behavior tests that need a real
# worktree to operate on (Wave 1's worktree-manager and orchestrator
# tests, plus any future stream that creates branches/worktrees).
#
# Usage:
#   test/behavior/fixtures/repo-init.sh /tmp/my-fixture-repo
#
# Idempotent: if the target directory already exists, it is wiped and
# recreated. The fixture is intentionally tiny — one file, one commit
# — so it stays under disk-cache friendly sizes.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <target-dir>" >&2
  exit 2
fi

TARGET="$1"

# We deliberately wipe-and-recreate. Behavior tests own this directory.
if [[ -e "$TARGET" ]]; then
  rm -rf "$TARGET"
fi
mkdir -p "$TARGET"

cd "$TARGET"

git init --quiet --initial-branch=main
git config user.email "harness@kobe.test"
git config user.name "kobe harness"
git config commit.gpgsign false

cat > README.md <<'EOF'
# kobe behavior fixture

Tiny git repo created by `test/behavior/fixtures/repo-init.sh`. Used by
behavior tests that need a real working copy to spawn worktrees from.
EOF

git add README.md
git commit --quiet -m "init: harness fixture"

# Print the resolved path (so the caller can capture it in $(...)).
pwd
