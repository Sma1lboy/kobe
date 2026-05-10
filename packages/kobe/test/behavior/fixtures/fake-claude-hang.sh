#!/bin/bash
# Long-running fake `claude` binary used to test `ClaudeCodeLocal.stop()`.
#
# Emits the system.init line so `spawn()` resolves, then sleeps until
# killed. The behavior test calls `stop()` and asserts the process is
# reaped within the SIGTERM grace + a small margin.

set -e

echo '{"type":"system","subtype":"init","session_id":"fake-session-hang","model":"fake-model"}'
# Use a long but finite sleep so a forgotten test never hangs the host.
sleep 60
