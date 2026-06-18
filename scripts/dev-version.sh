#!/usr/bin/env bash
#
# dev:version — run an isolated sandbox of a PAST kobe release, for bug repro.
#
# Usage:  bun run dev:version <git-tag-or-ref>      (e.g. v0.7.8)
#
# Checks the ref out into a gitignored worktree, installs that version's deps,
# and launches it with a per-version $KOBE_HOME_DIR + tmux socket — so it runs
# the REAL code of that release and never touches your real ~/.kobe or your
# main `dev:sandbox`. Reproduce a version-specific bug, then `git worktree
# remove` the checkout when you're done.
#
set -euo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: bun run dev:version <git-tag-or-ref>   (e.g. v0.7.8)" >&2
  echo "       list release tags with:  git tag | grep '^v'" >&2
  exit 2
fi

if ! git rev-parse --verify --quiet "${TAG}^{commit}" >/dev/null 2>&1; then
  echo "dev:version: unknown git ref '${TAG}'" >&2
  echo "             recent tags: $(git tag | grep '^v' | tail -5 | tr '\n' ' ')" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel)"
SAFE="$(printf '%s' "$TAG" | tr '/ ' '--')"
# Lives under packages/*/.dev-sandbox/, which .gitignore already excludes.
WT="$ROOT/packages/kobe/.dev-sandbox/versions/$SAFE"

if [ ! -d "$WT" ]; then
  echo "→ creating worktree for $TAG at ${WT#"$ROOT"/}" >&2
  git worktree add --detach "$WT" "$TAG"
else
  echo "→ reusing existing worktree at ${WT#"$ROOT"/}" >&2
fi

cd "$WT/packages/kobe"

# Guard against pre-sandbox releases that lack the isolated launch shape.
if ! grep -q '"dev:sandbox"' package.json; then
  echo "dev:version: $TAG predates the dev:sandbox script — cannot isolate its home safely." >&2
  echo "             check it out manually and launch with your own KOBE_HOME_DIR override." >&2
  exit 1
fi

echo "→ installing deps for $TAG (this can take a moment)…" >&2
bun install

HOME_DIR="$WT/packages/kobe/.dev-sandbox/home"
SOCKET="kobe-sandbox-$SAFE"
mkdir -p "$HOME_DIR"

# `--check`: non-interactive smoke test — boot the version, print its number, exit.
# Use it to confirm the repro sandbox actually runs before going interactive.
if [ "${2:-}" = "--check" ]; then
  echo "→ smoke check for $TAG (non-interactive --version)…" >&2
  exec env KOBE_DEV=1 KOBE_HOME_DIR="$HOME_DIR" KOBE_TMUX_SOCKET="$SOCKET" \
    bun ./src/cli/index.ts --version
fi

echo "→ launching $TAG" >&2
echo "    home:   ${HOME_DIR#"$ROOT"/}" >&2
echo "    socket: $SOCKET   (isolated — your real ~/.kobe is untouched)" >&2
echo "    remove when done:  git worktree remove ${WT#"$ROOT"/}" >&2

exec env KOBE_DEV=1 KOBE_HOME_DIR="$HOME_DIR" KOBE_TMUX_SOCKET="$SOCKET" \
  bun --preload @opentui/solid/preload --conditions=browser ./src/cli/index.ts
