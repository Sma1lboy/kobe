#!/usr/bin/env sh
set -eu

# The product is Rove. `@sma1lboy/kobe` is the old package name, still
# published in lockstep, but this script moves everyone onto the new one:
# it's fetched fresh over curl on every run, so even a year-old install
# migrates itself the next time the user updates. Nothing is published
# solely to shepherd them across (no stub package, no deprecation shim).
PACKAGE="@sma1lboy/rove"
LEGACY_PACKAGE="@sma1lboy/kobe"

# Optional pin: `curl … | sh -s -- 0.7.90` installs that exact version;
# `… | sh -s -- --list` prints recent published versions and exits.
VERSION="${1:-}"

if [ "$VERSION" = "--list" ]; then
  npm view "$PACKAGE" versions --json 2>/dev/null | sed 's/[][",]//g' | awk 'NF' | tail -n 20
  echo ""
  echo "install one with: rove update <version>"
  echo "            or:   curl -fsSL https://raw.githubusercontent.com/Sma1lboy/rove/main/scripts/update.sh | sh -s -- <version>"
  exit 0
fi

# `rove` first: on a migrated install both commands exist, and the newer
# name is the one whose absence means "not migrated yet".
BIN="$(command -v rove 2>/dev/null || command -v kobe 2>/dev/null || true)"
BEFORE="$("${BIN:-false}" -v 2>/dev/null || true)"

# Update with the same package manager that owns the binary on PATH,
# otherwise the new version lands in another prefix and PATH keeps
# resolving the stale install (issue #205).
case "$BIN" in
  */.bun/*) MANAGER="bun" ;;
  *) MANAGER="npm" ;;
esac

# Is the install on PATH still the legacy package? Resolve the symlink and
# look at which package dir it lands in — `command -v` alone can't tell,
# since @sma1lboy/kobe ships a `rove` bin too.
MIGRATING=0
if [ -n "$BIN" ]; then
  ENTRY="$(realpath "$BIN" 2>/dev/null || readlink -f "$BIN" 2>/dev/null || echo "$BIN")"
  case "$ENTRY" in
    */@sma1lboy/kobe/*) MIGRATING=1 ;;
  esac
fi

if [ -n "$VERSION" ]; then
  TARGET="$VERSION"
else
  TARGET="$(npm view "${PACKAGE}" version 2>/dev/null || true)"
fi

if [ -t 1 ]; then
  BOLD='\033[1m'
  ACCENT='\033[38;2;204;120;92m'
  GREEN='\033[32m'
  RED='\033[31m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  BOLD='' ACCENT='' GREEN='' RED='' DIM='' RESET=''
fi

printf '%b\n' \
  "${ACCENT}${BOLD}██████╗  ██████╗ ██╗   ██╗███████╗" \
  "██╔══██╗██╔═══██╗██║   ██║██╔════╝" \
  "██████╔╝██║   ██║██║   ██║█████╗" \
  "██╔══██╗██║   ██║╚██╗ ██╔╝██╔══╝" \
  "██║  ██║╚██████╔╝ ╚████╔╝ ███████╗" \
  "╚═╝  ╚═╝ ╚═════╝   ╚═══╝  ╚══════╝${RESET}" \
  "${DIM}many sessions. one terminal.${RESET}" \
  ""

if [ "$MIGRATING" = "1" ]; then
  printf '%bkobe is now Rove.%b %s -> %s — same tool, same `kobe` command, new name.\n' \
    "$BOLD" "$RESET" "$LEGACY_PACKAGE" "$PACKAGE"
fi

if [ -n "$TARGET" ]; then
  printf '%bUpdating %s: %s -> v%s%b (via %s)\n' "$BOLD" "$PACKAGE" "${BEFORE:-not installed}" "$TARGET" "$RESET" "$MANAGER"
else
  printf '%bUpdating %s via %s...%b\n' "$BOLD" "$PACKAGE" "$MANAGER" "$RESET"
fi

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

# Both packages own a `kobe` AND a `rove` bin, so installing one over the
# other dies with EEXIST (verified on npm 11). The legacy package has to go
# first — and only once we're about to replace it, so a failed install
# can't leave the user with nothing.
if [ "$MIGRATING" = "1" ]; then
  "$MANAGER" uninstall -g "$LEGACY_PACKAGE" >>"$LOG" 2>&1 || true
fi

"$MANAGER" install -g "${PACKAGE}@${VERSION:-latest}" >>"$LOG" 2>&1 &
PID=$!

if [ -t 1 ]; then
  # ponytail: braille spinner, same glyph set as the TUI's DEFAULT_SPINNER_FRAMES
  # (packages/kobe/src/engine/spinner-frames.ts) — keep the two in sync by eye.
  set -- ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
  while kill -0 "$PID" 2>/dev/null; do
    frame=$1
    shift
    set -- "$@" "$frame"
    printf '\r%b%s%b installing...' "$DIM" "$frame" "$RESET"
    sleep 0.1
  done
  printf '\r\033[K'
fi

if ! wait "$PID"; then
  printf '%berror: %s install failed:%b\n' "$RED" "$MANAGER" "$RESET" >&2
  cat "$LOG" >&2
  # We removed the legacy package to free the bin names, so a failed
  # install would otherwise leave the user with no kobe at all. Put it
  # back before giving up.
  if [ "$MIGRATING" = "1" ]; then
    printf '%brestoring %s...%b\n' "$DIM" "$LEGACY_PACKAGE" "$RESET" >&2
    if "$MANAGER" install -g "${LEGACY_PACKAGE}@latest" >/dev/null 2>&1; then
      printf '%brestored — you are back on %s, nothing was lost.%b\n' "$DIM" "$LEGACY_PACKAGE" "$RESET" >&2
    else
      printf '%breinstall by hand: %s install -g %s%b\n' "$RED" "$MANAGER" "$LEGACY_PACKAGE" "$RESET" >&2
    fi
  fi
  exit 1
fi

# The shell caches command→path lookups; after swapping packages the cached
# entry points at a path that no longer exists.
hash -r 2>/dev/null || true

AFTER="$(rove -v 2>/dev/null || kobe -v 2>/dev/null || true)"

if [ -n "$TARGET" ] && [ "${AFTER##* }" != "$TARGET" ]; then
  echo "error: 'rove' on PATH reports '${AFTER:-nothing}' but the target is ${TARGET}." >&2
  echo "PATH resolves rove to: $(command -v rove || echo 'not found')" >&2
  echo "Another install is likely shadowing it. Remove the stale one or run: ${MANAGER} install -g ${PACKAGE}@${VERSION:-latest}" >&2
  exit 1
fi

printf '%b✓ %s -> %s%b\n' "$GREEN" "${BEFORE:-rove (not installed)}" "${AFTER:-unknown}" "$RESET"
if [ "$MIGRATING" = "1" ]; then
  printf '%bYou are on %s now. Both `kobe` and `rove` still work — your tasks, worktrees, and settings are untouched.%b\n' \
    "$DIM" "$PACKAGE" "$RESET"
fi
printf '%bThanks for using Rove. Happy building.%b\n' "$DIM" "$RESET"
