#!/usr/bin/env sh
set -eu

# One-step install for Rove, for a machine that has nothing yet.
#
#   curl -fsSL https://rove.sma1lboy.me/install.sh | sh
#   curl -fsSL https://rove.sma1lboy.me/install.sh | sh -s -- 0.8.136   # pin
#
# Rove's CLI is a Bun program, so this script installs Bun first when the
# machine has none, then installs the package with it. Updating later is
# `rove update` (scripts/update.sh), which reuses whichever package manager
# owns the binary on PATH.
PACKAGE="@sma1lboy/rove"
LEGACY_PACKAGE="@sma1lboy/kobe"
VERSION="${1:-}"

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

say() { printf '%b\n' "$1"; }
die() { printf '%berror: %b%b\n' "$RED" "$1" "$RESET" >&2; exit 1; }

printf '%b\n' \
  "${ACCENT}${BOLD}██████╗  ██████╗ ██╗   ██╗███████╗" \
  "██╔══██╗██╔═══██╗██║   ██║██╔════╝" \
  "██████╔╝██║   ██║██║   ██║█████╗" \
  "██╔══██╗██║   ██║╚██╗ ██╔╝██╔══╝" \
  "██║  ██║╚██████╔╝ ╚████╔╝ ███████╗" \
  "╚═╝  ╚═╝ ╚═════╝   ╚═══╝  ╚══════╝${RESET}" \
  "${DIM}many sessions. one terminal.${RESET}" \
  ""

case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux | Darwin | *BSD) ;;
  MINGW* | MSYS* | CYGWIN*)
    die "this script needs a POSIX shell. On Windows install Bun and Rove with npm:\n  npm install -g bun\n  npm install -g ${PACKAGE}"
    ;;
  *) say "${DIM}unrecognised platform — continuing anyway${RESET}" ;;
esac

command -v git >/dev/null 2>&1 || say "${DIM}note: git is not on PATH — Rove needs it to create task worktrees${RESET}"

# 1. Bun — the runtime Rove itself executes under.
BUN="$(command -v bun 2>/dev/null || true)"
if [ -z "$BUN" ] && [ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]; then
  BUN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
fi

if [ -z "$BUN" ]; then
  say "${BOLD}Installing Bun${RESET} ${DIM}(Rove's runtime — https://bun.sh)${RESET}"
  command -v curl >/dev/null 2>&1 || die "curl is required to install Bun"
  command -v unzip >/dev/null 2>&1 || say "${DIM}note: Bun's installer wants unzip; install it if the next step fails${RESET}"
  curl -fsSL https://bun.sh/install | bash || die "Bun install failed — install it manually from https://bun.sh, then re-run this script"
  BUN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
  [ -x "$BUN" ] || die "Bun installed but no binary at $BUN"
  say ""
else
  say "${DIM}bun found: ${BUN}${RESET}"
fi

BUN_BIN_DIR="$(dirname "$BUN")"

# 2. Rove. Both packages own the `rove` and `kobe` bin names, so an install
# on top of the pre-rename package dies with EEXIST — clear it first.
if [ -d "${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules/${LEGACY_PACKAGE}" ]; then
  say "${DIM}removing the pre-rename ${LEGACY_PACKAGE} first${RESET}"
  "$BUN" remove -g "$LEGACY_PACKAGE" >/dev/null 2>&1 || true
fi

say "${BOLD}Installing ${PACKAGE}${VERSION:+@$VERSION}${RESET}"
"$BUN" install -g "${PACKAGE}@${VERSION:-latest}" >/dev/null 2>&1 ||
  die "install failed — retry with output: ${BUN} install -g ${PACKAGE}@${VERSION:-latest}"

# 3. Report, and say exactly what to add to PATH when the bin dir is missing.
hash -r 2>/dev/null || true
if command -v rove >/dev/null 2>&1; then
  say "${GREEN}✓ $(rove -v 2>/dev/null || echo 'rove installed')${RESET}"
  say ""
  say "Next: ${BOLD}cd${RESET} into a git repo and run ${BOLD}rove${RESET}."
elif [ -x "${BUN_BIN_DIR}/rove" ]; then
  say "${GREEN}✓ $(PATH="${BUN_BIN_DIR}:$PATH" "${BUN_BIN_DIR}/rove" -v 2>/dev/null || echo 'rove installed')${RESET}"
  say ""
  say "${BOLD}${BUN_BIN_DIR} is not on your PATH yet.${RESET} Add it, then reopen your shell:"
  say "  echo 'export PATH=\"${BUN_BIN_DIR}:\$PATH\"' >> ~/.$(basename "${SHELL:-sh}")rc"
else
  die "installed, but no rove binary landed in ${BUN_BIN_DIR}"
fi

say ""
say "${DIM}Rove needs at least one agent CLI on PATH (claude, codex, copilot, kimi).${RESET}"
say "${DIM}Update later with: rove update${RESET}"
