#!/bin/bash
# Fake `claude` binary for ClaudeCodeLocal behavior tests.
#
# Why this exists: the real `claude` CLI costs Anthropic tokens, hits
# the network, and is non-deterministic. Behavior tests must validate
# the engine's plumbing without those properties. This script emits a
# scripted stream-json sequence that exercises every code path in
# `parseStreamJson`:
#   - `system.init` → captures session id (resolves spawn() promise)
#   - `assistant` text block → assistant.delta event
#   - `assistant` tool_use block → tool.start event
#   - `user` tool_result block → tool.result event
#   - `result success` with usage → usage event then done event
#
# The script takes whatever args claude takes and ignores them; it
# prints lines to stdout (one JSON per line) and exits 0.
#
# Pinned session id: `fake-session-0001` — tests assert exactly this id.

set -e

cat <<'EOF'
{"type":"system","subtype":"init","session_id":"fake-session-0001","model":"fake-model"}
{"type":"assistant","message":{"content":[{"type":"text","text":"hello from fake claude"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_a","name":"Read","input":{"path":"/etc/hosts"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_a","content":"127.0.0.1 localhost"}]}}
{"type":"result","subtype":"success","usage":{"input_tokens":7,"output_tokens":11},"total_cost_usd":0.0001}
EOF

exit 0
