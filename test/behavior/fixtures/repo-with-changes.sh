#!/usr/bin/env bash
# Build a fixture git repo with a known set of files and a known set
# of pending changes, used by the file tree pane behavior test
# (`test/behavior/filetree.test.ts`).
#
# Files committed to HEAD:
#   README.md
#   src/index.ts
#   src/util.ts
#
# Pending changes after init:
#   M src/index.ts   (modified in worktree)
#   ? new-file.txt   (untracked, not gitignored)
#
# `.gitignore` excludes `secret.log` so it won't appear in `All` even
# though it's on disk — proves the pane respects `--exclude-standard`.
#
# Usage:
#   test/behavior/fixtures/repo-with-changes.sh /tmp/fixture-repo
#
# Prints the resolved path on stdout. Idempotent: wipes the target on
# every call.
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

# Committed files
cat > README.md <<'EOF'
# kobe filetree fixture
EOF

mkdir -p src
cat > src/index.ts <<'EOF'
export const greeting = "hello, world"
EOF

cat > src/util.ts <<'EOF'
export function noop(): void {}
EOF

cat > .gitignore <<'EOF'
secret.log
EOF

git add README.md src/index.ts src/util.ts .gitignore
git commit --quiet -m "init: filetree fixture"

# Now create the pending changes the test expects:

# 1. Modify src/index.ts in the worktree (status:  M).
cat >> src/index.ts <<'EOF'

export const farewell = "goodbye"
EOF

# 2. Untracked, not-ignored file (status: ??).
cat > new-file.txt <<'EOF'
this file is untracked
EOF

# 3. A gitignored file that must NOT appear in either tab.
cat > secret.log <<'EOF'
sensitive content; should never appear in the pane
EOF

pwd
