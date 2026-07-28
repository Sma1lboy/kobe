---
"@sma1lboy/kobe": patch
---

Identify a tab's engine from its process tree instead of its window title

A shell tab where you ran `claude` yourself was identified by matching the OSC
window title against each engine's name. Engine titles are free-form activity
text, so a claude session whose summary mentioned "codex" relabelled its tab
codex and attached a Codex turn detector. Identity now comes from walking the
tab's shell for a live engine process, which also sees through launcher
wrappers and aliases, and is released the moment that process exits.
