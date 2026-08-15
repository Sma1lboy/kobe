---
"@sma1lboy/rove": patch
---

feat: `rove api` drive verbs reach tab precision everywhere a session is touched. `dispatch --tab tab-N` routes text into exactly that tab (the `session.deliver` payload now carries `tabId` end-to-end — daemon, web forwarder), so a fan-out group's "task X's tab Y" is finally expressible; `pane-open --tab tab-N` hosts the split in that tab instead of whatever happens to be focused, and `pane-close --tab tab-N` scopes its title match to one tab; `collect` rows now carry `.tabs` (the same join as `get-task`) so picking a `send --tab` target after a fan-out no longer needs a second hop.
