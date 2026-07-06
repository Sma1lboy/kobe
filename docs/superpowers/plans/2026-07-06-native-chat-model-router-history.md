# Native Chat Model Router History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kobe native chat own the conversation history while allowing same-provider automatic model selection before each turn.

**Architecture:** Keep provider runtime sessions as disposable execution caches. `tui/chat` owns a Kobe thread transcript, `engine/ai-sdk` converts that transcript into bounded prompt context, and a small same-provider router can override the next turn's model without changing the Kobe thread.

**Tech Stack:** TypeScript, Solid, Vitest, AI SDK harness, existing engine registry/capability contracts.

## Global Constraints

- Start from latest `origin/main`, not the old #223 branch.
- Do not introduce a third-party router service or a new dependency.
- Keep routing within the task's current provider.
- Treat provider session ids as disposable; Kobe thread history is the semantic source of truth.
- If the selected model changes, rebuild the provider runtime but still pass Kobe history into the next turn.
- Add a patch changeset.

---

### Task 1: Prompt Context Adapter

**Files:**
- Modify: `packages/kobe/src/engine/ai-sdk/harness-turn.ts`
- Test: `packages/kobe/test/engine/ai-sdk-harness-turn.test.ts`

**Interfaces:**
- Produces: `AiSdkConversationMessage` with `{ role: "user" | "assistant"; text: string }`.
- Produces: `buildPromptWithHistory(prompt: string, history?: readonly AiSdkConversationMessage[]): string`.
- Consumes later: `startAiSdkTurn({ history })`.

- [x] Write failing tests that `buildPromptWithHistory` leaves empty history unchanged and includes prior user/assistant turns before the new prompt.
- [x] Run `bun --filter @sma1lboy/kobe test:fast -- test/engine/ai-sdk-harness-turn.test.ts` and verify the new tests fail because the helper does not exist.
- [x] Implement `AiSdkConversationMessage`, bounded text serialization, `buildPromptWithHistory`, and have `startAiSdkTurn` pass the built prompt to `runtime.agent.stream`.
- [x] Re-run the focused test and verify it passes.

### Task 2: Native Chat Thread SOT

**Files:**
- Create: `packages/kobe/src/tui/chat/thread-history.ts`
- Modify: `packages/kobe/src/tui/chat/ChatPane.tsx`
- Test: `packages/kobe/test/tui/chat-thread-history.test.ts`

**Interfaces:**
- Produces: `chatItemsToAiSdkHistory(items: readonly ChatItem[]): readonly AiSdkConversationMessage[]`.
- Consumes: `startAiSdkTurn({ history })`.

- [x] Write failing tests that prompt rows and final assistant UI rows become history messages, error rows are ignored, and transient replacement of the assistant tail still yields one assistant message.
- [x] Run the focused test and verify it fails because the adapter file does not exist.
- [x] Implement `thread-history.ts` with conservative UIMessage text extraction for text-like parts.
- [x] Update `ChatPane.runTurn` to capture previous items as `history` before appending the new prompt and pass it to `startAiSdkTurn`.
- [x] Re-run the focused test and harness-turn test.

### Task 3: Same-Provider Router Hook

**Files:**
- Create: `packages/kobe/src/engine/ai-sdk/model-router.ts`
- Modify: `packages/kobe/src/tui/chat/ChatPane.tsx`
- Test: `packages/kobe/test/engine/model-router.test.ts`

**Interfaces:**
- Produces: `chooseTurnModel({ vendor, prompt, history, current, capabilities, autoModelEnabled, callSmallModel? }): Promise<ModelPickerResult>`.
- Consumes: current `ModelPickerResult`, provider capabilities, and history from Task 2.

- [x] Write failing tests for disabled router returning current/default model, router accepting only same-provider catalog choices, invalid choices falling back, and small-model call failure falling back.
- [x] Run the focused model-router test and verify it fails because the module does not exist.
- [x] Implement the router as an injected async decision function with a deterministic local fallback; no OpenRouter or new dependency.
- [x] Wire `ChatPane.runTurn` to resolve the model before `startAiSdkTurn`; manual current model remains the fallback.
- [x] Re-run focused tests.

### Task 4: Settings, Changeset, Verification

**Files:**
- Modify: existing TUI/web settings state files if present for native chat defaults.
- Modify: `packages/kobe/src/engine/codex-local/capabilities.ts` only if real model ids are available locally.
- Create: `.changeset/native-chat-model-router-history.md`

**Interfaces:**
- Produces: user-editable setting for auto model routing and router model where existing settings surfaces can already persist them.

- [x] Add a patch changeset describing native chat history SOT and same-provider model routing.
- [x] Run focused tests, `bun --filter @sma1lboy/kobe test:fast`, `bun run typecheck`, and `bun run lint`.
- [x] Restart sandbox daemon if daemon/orchestrator/engine changes require it.
- [ ] Commit only files for this PR, push the branch, and open a PR with the local `gh` CLI.
