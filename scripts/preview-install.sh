#!/usr/bin/env bash
#
# preview-install — overwrite the globally-installed PROD kobe with THIS
# checkout's build, for local testing only.
#
# Usage:  scripts/preview-install.sh        (from anywhere in the repo)
#
# What it does:
#   1. builds the current tree with the version baked as
#      `<version>-preview.<shortsha>` (CURRENT_VERSION reads package.json
#      at compile time, so `kobe -v` and the TUI update chip both say
#      "preview", and the published prod release always compares newer),
#   2. deletes the global install's dist/ and copies this build in,
#   3. patches the global package.json to the preview version.
#
# Going back to prod is the NORMAL update path — nothing special:
#   kobe update        (npm/bun reinstall @latest overwrites everything
#                       this script touched)
#
# Ceiling (ponytail): only dist/ is copied — if the dev tree changed the
# package's runtime *dependencies* since the installed prod release, the
# preview may crash on a missing module. Run `kobe update` first so the
# global dep tree is current, then preview-install again.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
PKG_SRC="$ROOT/packages/kobe"

BIN="$(command -v kobe 2>/dev/null || true)"
if [ -z "$BIN" ]; then
  echo "preview-install: no global kobe on PATH — install prod first: npm i -g @sma1lboy/kobe" >&2
  exit 1
fi
ENTRY="$(realpath "$BIN")" # …/node_modules/@sma1lboy/kobe/dist/cli/index.js
PKG_DIR="$(cd "$(dirname "$ENTRY")/../.." && pwd)"
case "$PKG_DIR" in
  */node_modules/@sma1lboy/kobe) ;;
  *)
    echo "preview-install: kobe on PATH ($BIN) doesn't resolve into a global @sma1lboy/kobe install (got: $PKG_DIR)" >&2
    exit 1
    ;;
esac

SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
# bun, not `npm pkg get`: npm aggregates the answer into a {name: version}
# map when the cwd is a workspace member, which poisoned the baked version.
BASE="$(cd "$PKG_SRC" && bun -p 'require("./package.json").version')"
PREVIEW="${BASE}-preview.${SHA}"

set_version() { # <dir> <version>
  (cd "$1" && bun -e '
    const f = "package.json"
    const j = JSON.parse(await Bun.file(f).text())
    j.version = process.argv[1]
    await Bun.write(f, `${JSON.stringify(j, null, 2)}\n`)
  ' "$2")
}

# Bake the preview version into the build, restore the file afterwards
# even on failure — the dev tree must never keep the preview version.
cp "$PKG_SRC/package.json" "$PKG_SRC/package.json.preview-bak"
trap 'mv "$PKG_SRC/package.json.preview-bak" "$PKG_SRC/package.json"' EXIT

echo "→ building ${PREVIEW}…"
set_version "$PKG_SRC" "$PREVIEW"
(cd "$PKG_SRC" && bun run build >/dev/null)

echo "→ replacing prod dist at ${PKG_DIR}"
rm -rf "$PKG_DIR/dist"
cp -R "$PKG_SRC/dist" "$PKG_DIR/dist"
set_version "$PKG_DIR" "$PREVIEW"

echo "✓ preview installed: $(kobe -v 2>/dev/null || echo 'kobe -v failed — check the build')"
echo "  back to prod any time:  kobe update"
