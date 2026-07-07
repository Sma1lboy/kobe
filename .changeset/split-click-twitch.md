---
"@sma1lboy/kobe": patch
---

Fix the whole-page twitch when clicking or switching panes in a split terminal group. Several causes: a plain click set a zero-width text selection that pushed new render content (then cleared it); clicking/switching a split leaf routed leaf focus through the persisted split tree (a state.json write + a full tree re-render), with the divider colour computed eagerly so the whole tree re-rendered to repaint it; and clicking an already-active tab or already-selected task re-created state / re-hit the daemon. Leaf focus is now a local signal with reactive border attributes, zero-width selections render nothing, and the no-op transitions (`selectTab`, task select) short-circuit.
