---
"@sma1lboy/kobe": patch
---

The web notes scratchpad gains a markdown preview toggle (Edit ⇄ Preview): a minimal, safe renderer (headings, lists, blockquotes, inline/fenced code, bold/italic, links, hr) turns notes into formatted text. Security-first — it escapes all input before composing tags (no raw HTML can be injected) and only allows http/https/relative link hrefs (`javascript:` and friends render as inert text), covered by tests including XSS cases. The preview re-themes with the rest of the dashboard.
