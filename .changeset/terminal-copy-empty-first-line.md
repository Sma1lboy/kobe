---
"@sma1lboy/kobe": patch
---

Fix embedded-terminal copy losing a line when a selection starts in the blank space past a short line: dragging from the empty padding to the right of a short row down into the next line highlighted both rows but copied only the lower one, silently dropping the leading blank line (and its newline) so two visibly-selected lines collapsed into one. The copy now keeps every highlighted row — an empty first line contributes an empty line, matching what the on-screen selection shows.
