#!/usr/bin/env sh
set -eu

PACKAGE="@sma1lboy/kobe"

BIN="$(command -v kobe 2>/dev/null || true)"
BEFORE="$("${BIN:-false}" -v 2>/dev/null || true)"

case "$BIN" in
  */.bun/*) MANAGER="bun" ;;
  *) MANAGER="npm" ;;
esac

echo "Updating ${PACKAGE} via ${MANAGER}..."
"$MANAGER" install -g "${PACKAGE}@latest"

AFTER="$(kobe -v 2>/dev/null || true)"
LATEST="$(npm view "${PACKAGE}" version 2>/dev/null || true)"

if [ -n "$LATEST" ] && [ "${AFTER##* }" != "$LATEST" ]; then
  echo "error: 'kobe' on PATH reports '${AFTER:-nothing}' but latest is ${LATEST}." >&2
  echo "PATH resolves kobe to: $(command -v kobe || echo 'not found')" >&2
  echo "Another install is likely shadowing it. Remove the stale one or run: ${MANAGER} install -g ${PACKAGE}@latest" >&2
  exit 1
fi

echo "${BEFORE:-kobe (not installed)} -> ${AFTER:-unknown}"
