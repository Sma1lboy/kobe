---
"@sma1lboy/kobe": patch
---

Peer messages now make loading the kobe agent skill mandatory, not suggested. The `[KOBE PEER]` prefix leads with "load the kobe agent skill FIRST (required)" before the baked-in reply command, and the skill (v10) hardens both sides of the contract: agent-to-agent coordination goes through `kobe api send` only — never a human relay or a generic peer channel — and `--plain` is reserved for verbatim content, not coordination. A real round-trip had fallen back to a human relay because neither side had the skill's contract in context.
