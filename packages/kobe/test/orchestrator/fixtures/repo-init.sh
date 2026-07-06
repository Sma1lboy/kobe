#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <target-dir>" >&2
  exit 2
fi

TARGET="$1"

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

Tiny git repo created by `test/behavior/fixtures/repo-init.sh`. Used by
behavior tests that need a real working copy to spawn worktrees from.
EOF

git add README.md
git commit --quiet -m "init: harness fixture"

pwd
