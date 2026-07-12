#!/usr/bin/env sh
set -eu

PACKAGE="@sma1lboy/kobe"

# Optional pin: `curl … | sh -s -- 0.7.90` installs that exact version;
# `… | sh -s -- --list` prints recent published versions and exits.
VERSION="${1:-}"

if [ "$VERSION" = "--list" ]; then
  npm view "$PACKAGE" versions --json 2>/dev/null | sed 's/[][",]//g' | awk 'NF' | tail -n 20
  echo ""
  echo "install one with: kobe update <version>"
  echo "            or:   curl -fsSL https://raw.githubusercontent.com/Sma1lboy/kobe/main/scripts/update.sh | sh -s -- <version>"
  exit 0
fi

BIN="$(command -v kobe 2>/dev/null || true)"
BEFORE="$("${BIN:-false}" -v 2>/dev/null || true)"

# Update with the same package manager that owns the binary on PATH,
# otherwise the new version lands in another prefix and PATH keeps
# resolving the stale install (issue #205).
case "$BIN" in
  */.bun/*) MANAGER="bun" ;;
  *) MANAGER="npm" ;;
esac

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
  "${ACCENT}${BOLD}██╗  ██╗ ██████╗ ██████╗ ███████╗" \
  "██║ ██╔╝██╔═══██╗██╔══██╗██╔════╝" \
  "█████╔╝ ██║   ██║██████╔╝█████╗" \
  "██╔═██╗ ██║   ██║██╔══██╗██╔══╝" \
  "██║  ██╗╚██████╔╝██████╔╝███████╗" \
  "╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝${RESET}" \
  "${DIM}many sessions. one terminal.${RESET}" \
  ""

if [ -n "$TARGET" ]; then
  printf '%bUpdating %s: %s -> v%s%b (via %s)\n' "$BOLD" "$PACKAGE" "${BEFORE:-not installed}" "$TARGET" "$RESET" "$MANAGER"
else
  printf '%bUpdating %s via %s...%b\n' "$BOLD" "$PACKAGE" "$MANAGER" "$RESET"
fi

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

"$MANAGER" install -g "${PACKAGE}@${VERSION:-latest}" >"$LOG" 2>&1 &
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
  exit 1
fi

AFTER="$(kobe -v 2>/dev/null || true)"

if [ -n "$TARGET" ] && [ "${AFTER##* }" != "$TARGET" ]; then
  echo "error: 'kobe' on PATH reports '${AFTER:-nothing}' but the target is ${TARGET}." >&2
  echo "PATH resolves kobe to: $(command -v kobe || echo 'not found')" >&2
  echo "Another install is likely shadowing it. Remove the stale one or run: ${MANAGER} install -g ${PACKAGE}@${VERSION:-latest}" >&2
  exit 1
fi

printf '%b✓ %s -> %s%b\n' "$GREEN" "${BEFORE:-kobe (not installed)}" "${AFTER:-unknown}" "$RESET"
printf '%bThanks for using kobe. Happy building.%b\n' "$DIM" "$RESET"
