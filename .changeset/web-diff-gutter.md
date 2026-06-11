---
"@sma1lboy/kobe": patch
---

The web diff view now renders a line-number gutter — a unified-diff parser computes old/new line numbers from each hunk header and shows two aligned gutter columns next to the content, so reviewing an agent's changes reads like a real diff instead of raw `+`/`-` lines. Added lines show the new-file number, removed lines the old-file number, context both; hunk and file-header rows span the gutter. The hunk-math is covered by tests.
