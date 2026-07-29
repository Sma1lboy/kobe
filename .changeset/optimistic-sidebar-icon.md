---
"@sma1lboy/kobe": patch
---

The sidebar activity icon now reacts on the keypress: enter in an engine tab starts the spinner immediately and a bare esc stops it, through a local optimistic overlay that authoritative engine events and short TTLs always correct — no label text is ever derived from a guess. Needs-input shows as a literal `?` (was ◉).
