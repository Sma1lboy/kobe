---
"@sma1lboy/kobe": patch
---

Fix the daemon PR-status poller so an unrecognized `gh` failure surfaces as an error instead of silently masquerading as "no PR" (switched to `gh pr list --head` and a single shared failure classifier), and cache `RemoteExecHost` instances by ControlMaster socket so remote-project git operations stop paying a synchronous SSH connection check on every call.
