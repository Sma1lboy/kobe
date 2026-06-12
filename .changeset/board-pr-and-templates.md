---
"@sma1lboy/kobe": patch
---

**Open-PR button + editable quick-action templates** — `Done` cards without a PR grow a pull-request button that asks the task's own session to push the branch and `gh pr create` (the agent that did the work writes the title/body, following the repo's conventions). Both quick-action instructions are now template-editable in `kobe web`'s Settings → Board quick actions (stored host-side in state.json): your template forms the first half, and kobe always APPENDS its clause after it — the review's one-time `done` authorization and the PR's reply-with-URL rule can't be edited away. Empty template = built-in default.
