---
"@sma1lboy/kobe": patch
"@sma1lboy/kobe-plugin-sdk": patch
---

Persist engine-native session identities per task tab so structured history
and Agent Trace consumers remain attached across daemon restarts. The browser
now consumes the durable binding contract instead of inferring a session from
terminal pixels or the newest transcript.
