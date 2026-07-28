#!/bin/sh
# examples.browser — run carbonyl (Chromium rendered as terminal cells) in a
# kobe pane tab. The URL comes from the state file the `open` action writes;
# falls back to BROWSER_HOME from config, then example.com.

state_url="$KOBE_PLUGIN_STATE_DIR/url"
url=""
[ -f "$state_url" ] && url=$(cat "$state_url")
if [ -z "$url" ] && [ -n "$KOBE_PLUGIN_CONFIG_DIR" ] && [ -f "$KOBE_PLUGIN_CONFIG_DIR/.env" ]; then
  . "$KOBE_PLUGIN_CONFIG_DIR/.env"
  url="$BROWSER_HOME"
fi
[ -z "$url" ] && url="https://example.com"

# Plugin-local install first (the [[build]] step provisions it on install);
# PATH and npx are the fallbacks for linked dev checkouts that skipped build.
local_bin="$KOBE_PLUGIN_ROOT/node_modules/.bin/carbonyl"
if [ -x "$local_bin" ]; then
  exec "$local_bin" "$url"
fi
if command -v carbonyl >/dev/null 2>&1; then
  exec carbonyl "$url"
fi
if command -v npm >/dev/null 2>&1; then
  echo "carbonyl not provisioned — installing into the plugin directory…"
  (cd "$KOBE_PLUGIN_ROOT" && npm install --no-audit --no-fund) && exec "$local_bin" "$url"
fi
echo "examples.browser needs carbonyl (https://github.com/fathyb/carbonyl) and npm to provision it"
echo "press enter to close"
read -r _
