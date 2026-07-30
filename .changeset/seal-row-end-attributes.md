---
"@sma1lboy/kobe": patch
---

Fix link underline (and any styled run) bleeding into the rest of the terminal pane

A styled run that reached the terminal's last column — a wrapped URL being the
common case — left its attribute open, so every following row rendered
underlined until something else happened to reset it. Root cause is in
opentui's renderer, which skips its `\e[0m` reset on the first cell of a new
row; kobe now seals the final cell of a full-width row, replaying an inverse
cell as swapped colors so a cursor or selection parked in the last column stays
visible.
