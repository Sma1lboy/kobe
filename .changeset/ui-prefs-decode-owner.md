---
"@sma1lboy/kobe": patch
---

Internal: the `ui-prefs` wire decode (theme guard + the backward-compat defaults that let an older daemon's payload omit newer fields without resetting them) now lives in one pure, unit-tested `decodeUiPrefsPayload` instead of inline in the client's channel switch. No behavior change — the version-negotiation rules (notably "absent locale → leave the language alone", not reset to English) are now regression-netted.
