---
"@sma1lboy/kobe": patch
---

The web chat transcript's context readout no longer shows an impossible "1000.0k" just below a million tokens. The compact token formatter tested its unit threshold before rounding, so a value like 999,999 fell into the "k" branch and then `(value / 1000).toFixed(1)` rounded it up to `1000.0k` — a real readout on long-context sessions parked just under 1m. It now promotes to "m" at the boundary the rounding actually crosses (999,950), the same promote-before-rounding rule the file preview's byte formatter already uses, so those sessions read "1.0m".
