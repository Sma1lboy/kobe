---
"@sma1lboy/kobe": patch
---

Fixed a pane that redrew forever with no new output: the chunk converter decided the zebra-stripe block substitution from opaque color keys while the comparator decided it from resolved RGB, so a half-block cell mixing palette and truecolor (the normal case for carbonyl and the video player) always compared as "changed". Both now share one `paintsSamePixel` definition, and a self-match invariant test makes any future converter transform prove it has a mirror.
