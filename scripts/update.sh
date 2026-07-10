#!/usr/bin/env sh
set -eu

PACKAGE="@sma1lboy/kobe"

BIN="$(command -v kobe 2>/dev/null || true)"
BEFORE="$("${BIN:-false}" -v 2>/dev/null || true)"

# Update with the same package manager that owns the binary on PATH,
# otherwise the new version lands in another prefix and PATH keeps
# resolving the stale install (issue #205).
case "$BIN" in
  */.bun/*) MANAGER="bun" ;;
  *) MANAGER="npm" ;;
esac

LATEST="$(npm view "${PACKAGE}" version 2>/dev/null || true)"

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

if [ -n "$LATEST" ]; then
  printf '%bUpdating %s: %s -> v%s%b (via %s)\n' "$BOLD" "$PACKAGE" "${BEFORE:-not installed}" "$LATEST" "$RESET" "$MANAGER"
else
  printf '%bUpdating %s via %s...%b\n' "$BOLD" "$PACKAGE" "$MANAGER" "$RESET"
fi

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

"$MANAGER" install -g "${PACKAGE}@latest" >"$LOG" 2>&1 &
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

if [ -n "$LATEST" ] && [ "${AFTER##* }" != "$LATEST" ]; then
  echo "error: 'kobe' on PATH reports '${AFTER:-nothing}' but latest is ${LATEST}." >&2
  echo "PATH resolves kobe to: $(command -v kobe || echo 'not found')" >&2
  echo "Another install is likely shadowing it. Remove the stale one or run: ${MANAGER} install -g ${PACKAGE}@latest" >&2
  exit 1
fi

printf '%b✓ %s -> %s%b\n' "$GREEN" "${BEFORE:-kobe (not installed)}" "${AFTER:-unknown}" "$RESET"
printf '%bThanks for using kobe. Happy building.%b\n' "$DIM" "$RESET"
