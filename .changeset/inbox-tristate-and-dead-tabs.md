---
"@sma1lboy/kobe": patch
---

The Inbox's header count and its list agree again, and RECENT drops rows whose tab has closed. Three surfaces still asked "does this tab exist" with a binary check that read "this process can't see that task's tabs" as "the tab is gone": the badge counted episodes the dialog hid, pressing enter on such a row silently dismissed it instead of navigating, and F7 skipped it entirely to toast "nothing needs you". All availability questions now route through one tri-state helper. Separately, nothing pruned the visit log when a tab closed, so closing several tabs of one task left identical RECENT rows that each consumed a slot and opened nothing.
