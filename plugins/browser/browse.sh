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

if command -v carbonyl >/dev/null 2>&1; then
  exec carbonyl "$url"
fi
# ponytail: npx fallback downloads the platform binary on first run (~100MB)
if command -v npx >/dev/null 2>&1; then
  echo "carbonyl not on PATH — falling back to npx (first run downloads Chromium)…"
  exec npx -y carbonyl "$url"
fi
echo "examples.browser needs carbonyl: npm i -g carbonyl  (https://github.com/fathyb/carbonyl)"
echo "press enter to close"
read -r _
