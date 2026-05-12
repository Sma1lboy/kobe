# Handoff — Vendor content neutralization (KOB-49)

> Written 2026-05-11. Branch `kobe/vendor-content-neutral`, 3 commits ahead of `main`. Linear: [KOB-49](https://linear.app/codesfox/issue/KOB-49) (Done; reopen if you continue past the step 3 line). This file lives on the branch so whoever picks the kobe task back up has the same context the original session had.

## What landed

Three commits, each a self-contained PR-sized refactor. Sequence matters — step 1 is the dependency for the rest. `git log main..HEAD --oneline`:

| Commit | Subject |
|---|---|
| `7aa567f` | step 1 — neutral content blocks via vendor adapter |
| `0c112be` | step 2 — `VendorId` + `ModelChoice.vendor` |
| `96d5dca` | step 3 — tool name → render strategy registry |

### Step 1 (`7aa567f`) — neutral content union

- New `packages/kobe/src/types/content.ts`: `ContentBlock` discriminated union — `text | tool_call | tool_result | thinking`.
- `Message.content: unknown` → `Message.blocks: readonly ContentBlock[]` (`types/engine.ts`).
- New `engine/claude-code-local/normalize.ts`: `normalizeClaudeContent(unknown) → ContentBlock[]`. Single chokepoint where the Claude on-disk shape (string OR content-block array, with `tool_use` / `tool_result` / `tool_use_id` / `is_error` / `thinking`) collapses into the neutral form.
- `engine/claude-code-local/history.ts::extractMessage` and `sessions.ts::stringifyContent` route through the normalizer.
- `tui/panes/chat/store.ts::appendRowsFromMessage` no longer destructures raw Claude shapes — consumes `m.blocks` and switches on neutral `block.type`.
- Drops `image` / `redacted_thinking` explicitly — was already a silent drop pre-refactor.
- Tests migrated from `content: ...` literals to `blocks: [{type, ...}, ...]`. Wire format (daemon protocol) changes from `{role, content}` to `{role, blocks}` — kobe daemon + TUI ship together so no migration is needed.

### Step 2 (`0c112be`) — vendor + model

- New `packages/kobe/src/types/vendor.ts`: `VendorId = "claude" | "codex"`.
- `ModelChoice` (in `tui/panes/chat/composer/models.ts`) gains `vendor: VendorId`. All 5 `MODEL_CHOICES` entries are `vendor: "claude"` for now.
- `Task.model` deliberately left as plain `string` (don't double-persist vendor; it's inferable from picker context).
- **`PermissionMode` rename intentionally dropped** — the original plan said "解绑 Claude 词汇" but on closer look `"default"` is kobe's own neutral term, not Claude-CLI vocab (`bypassPermissions` / `acceptEdits` are already encapsulated in `claude-code-local/index.ts:160`). Renaming would only churn `state.json`. Don't redo it.

### Step 3 (`96d5dca`) — tool render registry

- New `packages/kobe/src/tui/panes/chat/tool-registry.ts`: `ToolMeta { bucket, banner, body }` per tool name, per vendor. `lookupToolMeta(name, vendor="claude")` and `classifyTool(name, vendor="claude")` are the public surface.
- `MessageList.tsx::ToolRow` no longer spells out `r().name === "Bash" / "Edit" / "Read" / ...`. Strategy flags come from the registry. The JSX components (`BashBanner`, `ReadGrepGlobBanner`, `EditWriteDiffBlock`, etc.) stay where they are — moving them would be ~400 lines of churn for zero behavior change.
- One residual name comparison remains in `diff()` for Edit/Write formatter dispatch. Left in place by design: the formatters consume Claude-shaped input (`old_string` / `new_string` / `file_path`), so the dispatch IS Claude-vendor knowledge.

## What's NOT done yet (next-up candidates)

In rough priority:

1. **Wire `Task.vendor: VendorId`**. Step 2 added `VendorId` and `ModelChoice.vendor`, but no `Task` field references it yet. Without it, `lookupToolMeta(name, vendor)` always uses the `"claude"` default. Path:
   - Add `vendor?: VendorId` to `types/task.ts::Task` (optional for migration).
   - `Orchestrator.createTask` derives from `model` (or defaults to `"claude"`).
   - Plumb through the daemon protocol `SerializedTask`.
   - Thread into chat-row rendering so `lookupToolMeta(name, row.vendor)` works.
2. **Document the vendor seam in `docs/DESIGN.md` §5.2** ("The AI Engine Port"). The interface section there still describes `Message.content: unknown`. Update with the neutral `blocks` model + vendor registry.
3. **`engine/dev-fake.ts`**: still emits the old-shaped Messages in some test fixtures. The unit tests are migrated, but the in-process fake engine may produce raw shapes in places — sweep.
4. **CHANGELOG.md** entry under `## [Unreleased]` describing the neutralization. Use the changelog-generator skill or write by hand. Three lines, no soft-wrap.

## Don't redo / known traps

- **PermissionMode rename**. Looked appealing in the original plan; not actually a leak. Skip.
- **Lifting tool renderer JSX components into the registry as components**. ~400 lines of churn for marginal benefit. The current registry-as-strategy-flags shape is the right intervention size.
- **Treating `approval` payloads as vendor-neutral**. `ApprovePlanPayload` / `AskQuestionPayload` mirror Claude's `ExitPlanMode` / `AskUserQuestion` tool shapes 1:1. Codex has no corresponding tool, so any "neutralization" would be lossy invention. Wait until a second vendor lands and design from real data, not speculation.
- **Renaming `cache_read_input_tokens` / `cache_creation_input_tokens`**. Used in `context-meter.ts`, `store.ts`, `stream.ts`, `types/engine.ts`. The cost of rename touches 4+ files and the benefit is "the field names don't say Anthropic." Not worth it.

## Verification at handoff

Last green state on this branch (`96d5dca`):

```
bun x tsc --noEmit                                       # clean
bun run test test/tui test/engine test/types test/daemon test/orchestrator test/state test/cli
                                                         # 663 / 663 unit
```

Behavior tests show 30 failures, **all environmental** (PTY bridge socket EADDRINUSE under concurrent vitest workers — same shape on `main`). Don't chase them as part of this work.

## Open KOB-49 follow-up — see Linear comment from 2026-05-11

If you keep extending vendor-neutralization beyond what this handoff describes, **reopen KOB-49 first** (it's currently Done). New issue is fine too — link from KOB-49 so the trail stays connected.
