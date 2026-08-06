#!/usr/bin/env bash
# Copy PART 1 daemon/kobe edits staged under .part1-staging into the monorepo.
# Needed when the Cursor workspace is packages/kobe-web (sibling writes blocked).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGING="$(cd "$(dirname "$0")" && pwd)/.part1-staging"
cp "$STAGING/packages/kobe/src/tui/panes/sidebar/worktree-changes.ts" \
  "$ROOT/packages/kobe/src/tui/panes/sidebar/worktree-changes.ts"
cp "$STAGING/packages/kobe/src/core/daemon-runtime.ts" \
  "$ROOT/packages/kobe/src/core/daemon-runtime.ts"
cp "$STAGING/packages/kobe-daemon/src/daemon/contracts.ts" \
  "$ROOT/packages/kobe-daemon/src/daemon/contracts.ts"
cp "$STAGING/packages/kobe-daemon/src/daemon/worktree-changes-collector.ts" \
  "$ROOT/packages/kobe-daemon/src/daemon/worktree-changes-collector.ts"
echo "PART 1 applied into $ROOT"
