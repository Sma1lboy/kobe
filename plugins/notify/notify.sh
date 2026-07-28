#!/bin/sh
# examples.notify — desktop + optional ntfy notification for kobe agent events.
# Kobe injects KOBE_PLUGIN_EVENT / KOBE_PLUGIN_TASK_TITLE / KOBE_PLUGIN_CONFIG_DIR.

event="${1:-$KOBE_PLUGIN_EVENT}"
task="${KOBE_PLUGIN_TASK_TITLE:-a task}"

case "$event" in
  agent.turn-complete)     body="$task: agent finished its turn" ;;
  agent.permission-needed) body="$task: agent is waiting on a permission prompt" ;;
  agent.rate-limited)      body="$task: agent hit a rate limit" ;;
  agent.error)             body="$task: agent errored" ;;
  *)                       body="Test notification from examples.notify" ;;
esac

if [ "$(uname)" = "Darwin" ]; then
  # ponytail: naive quote-stripping instead of full AppleScript escaping
  safe=$(printf '%s' "$body" | tr -d '"\\')
  osascript -e "display notification \"$safe\" with title \"kobe\"" >/dev/null 2>&1 || true
elif command -v notify-send >/dev/null 2>&1; then
  notify-send "kobe" "$body" || true
fi

# Optional push: put NTFY_URL=https://ntfy.sh/<your-topic> in "$KOBE_PLUGIN_CONFIG_DIR/.env"
if [ -n "$KOBE_PLUGIN_CONFIG_DIR" ] && [ -f "$KOBE_PLUGIN_CONFIG_DIR/.env" ]; then
  . "$KOBE_PLUGIN_CONFIG_DIR/.env"
  if [ -n "$NTFY_URL" ]; then
    curl -fsS -m 5 -d "$body" "$NTFY_URL" >/dev/null 2>&1 || true
  fi
fi
