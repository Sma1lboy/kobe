# Codex Task Title Generation

## Goal

Add Codex-only AI refinement on top of kobe's current "first user prompt truncated to 40 characters" auto-title behavior.

The title should be concise, recognizable in the sidebar, and generated in the background without blocking the engine session. Manual task renames must always win.

## Current Behavior

Fresh tasks start with `(new task)`. The daemon auto-title poller reads engine transcripts and renames still-placeholder tasks from the first real user message by calling `deriveTitleFromPrompt()`. That function collapses whitespace and truncates the prompt.

This is cheap and robust, but poor for pasted briefs, multi-step prompts, and non-English prompts with lots of setup before the actual task.

## Pattern To Reuse

The desired product shape is a layered strategy:

- Generate a short session title asynchronously with a small model.
- Prompt the model for a 3-7 word sentence-case title returned as JSON.
- Feed a bounded text window, not an unlimited transcript.
- Use a fast text-derived fallback while AI is unavailable or still running.
- Distinguish AI titles from user custom titles so user titles are never overwritten.

kobe should copy the product shape for Codex tasks in this PR. Claude, Copilot, and custom engines keep the existing fallback-only behavior.

## Design

Add an engine-owned title generation contract, with a default implementation that can return `null` when the engine should not generate titles. The daemon auto-title pass remains the coordinator.

Codex is the only engine with a real title generator in this PR. Claude, Copilot, and custom engines use the default no-op generator and therefore keep their fallback title.

Auto-title remains a daemon-coordinated best-effort flow. kobe does not need a new persisted task field for title provenance: each async write re-reads the live task title and only proceeds if the title is still at the value that this pass last wrote.

The initial daemon pass should behave like this:

1. Read the task's origin transcript through the existing engine history reader.
2. Extract title input from real human-authored user/assistant text, skipping meta, synthetic, tool-result, and non-human-origin messages where the normalized history exposes that distinction.
3. Limit title input to a small bounded window, around 1000 characters.
4. Compute a deterministic fallback using the current `deriveTitleFromPrompt()` behavior, with a slightly better "first sentence then truncate" cleanup if needed.
5. If the task still has no visible title beyond `(new task)`, set the fallback title quickly.
6. Start an async AI title generation attempt.
7. If the AI title succeeds and the task title still equals the fallback this pass wrote, replace the fallback with the AI title.
8. If AI fails, keep the fallback and do not retry aggressively.

AI title prompt:

```text
Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding task. The title should be clear enough that the user recognizes the task in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix mobile login button"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client errors"}
```

The returned title must be trimmed, single-line, non-empty, and capped before entering the task index. Invalid JSON, empty title, model error, timeout, or missing title capability falls back without surfacing an error in the UI.

## Branch Behavior

Branch-follow stays conservative. A task whose branch is still the placeholder-derived branch may follow the first useful title update once, as it does today. Manual branch changes still win.

If fallback is applied first and AI replaces it shortly after, kobe should avoid repeatedly renaming an already materialized branch. The branch should follow the first non-placeholder title only; later AI refinement should change the sidebar title but not churn git branch names.

## UI Behavior

No new modal is required.

The sidebar should update live through the existing task snapshot flow. The task row can simply show the current `task.title`. A future status hint for "AI naming..." is out of scope.

Manual rename through `r` or `kobe api rename` wins because the daemon re-checks the live task title before every auto-title write.

## Error Handling

Title generation is best effort:

- It must never block task creation, task entry, or engine input.
- It must not crash the daemon.
- It should log unexpected failures through the daemon error logger.
- It should avoid tight retries. Once fallback exists and AI fails, the next normal transcript/title pass may skip unless the implementation has a cheap reason to retry.

## Testing

Unit tests should cover:

- fallback title extraction from prompt text;
- AI title JSON parsing and validation;
- manual titles are never overwritten;
- placeholder tasks get fallback, then AI title when generation succeeds;
- AI failure keeps fallback;
- branch-follow does not churn after fallback-to-AI refinement.

Daemon/orchestrator tests should inject fake title generators rather than call real model APIs.

Behavior coverage should prove a newly prompted task eventually updates from `(new task)` to a readable generated title using a fake engine/title generator.

## Non-Goals

- Do not implement a title editor suggestion UI.
- Do not generate titles for archived tasks.
- Do not rename ChatTabs in this pass unless they already use the shared task title path.
- Do not add provider-specific checks in neutral UI code.
- Do not call external model APIs from tests.
