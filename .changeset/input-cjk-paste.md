---
"@sma1lboy/kobe": patch
---

fix: stop dropping multi-line paste and full-width-space prompts in input fields

The feedback "description" field used an opentui `<input>`, which strips
newlines inside the native widget on paste — so a multi-line pasted bug report
was silently collapsed to one line. It is now a `<textarea>` that preserves
paragraph structure (enter inserts a newline; tab moves to Send), while the
single-line fields (title, branch, repo, prompt) keep stripping newlines.

The quick-task prompt and rename-task title guards also accepted a prompt/title
made only of a full-width space `　` (U+3000), which `String.prototype.trim()`
does not strip — submitting an empty-looking task. Both now reject any value
with no non-whitespace character via a shared `isBlankText` predicate.
