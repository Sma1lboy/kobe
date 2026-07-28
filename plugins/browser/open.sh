#!/bin/sh
# examples.browser.open <url> — remember the URL, then open (or re-open) the
# browser pane on the active task. Invoked from anywhere:
#   kobe plugin action invoke examples.browser.open https://localhost:5173

url="$1"
if [ -z "$url" ]; then
  echo "usage: kobe plugin action invoke examples.browser.open <url>"
  exit 2
fi
case "$url" in
  http://*|https://*) ;;
  *) url="https://$url" ;;
esac
mkdir -p "$KOBE_PLUGIN_STATE_DIR"
printf %s "$url" > "$KOBE_PLUGIN_STATE_DIR/url"
exec "${KOBE_BIN_PATH:-kobe}" plugin pane open examples.browser.browse
