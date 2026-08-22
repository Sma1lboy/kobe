---
"@sma1lboy/rove": patch
---

`api dispatch` and `api inspect` now report delivery reach. `session.deliver` is broadcast-only — an attached client performs the paste — so a dispatch with nothing listening published into the void and still answered `ok: true`, indistinguishable from a delivered paste. `dispatch` now returns the daemon's `clients` count and `inspect` reports `connectedClients`, so an answer that reached nobody is visible instead of silent. Non-zero is not proof of the converse (the calling CLI is itself a connection) — confirm a real session host with `api pty-list`.
