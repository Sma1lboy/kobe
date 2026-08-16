---
"@sma1lboy/rove": patch
---

Archiving the selected task no longer flashes the screen or resurrects its engine: selection now moves off an archived/deleting task in the same snapshot tick, so its terminal unmounts instead of answering the PTY sweep with a dead-on-attach respawn (issue #34).
