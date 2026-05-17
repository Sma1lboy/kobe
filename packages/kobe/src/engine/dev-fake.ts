/**
 * `DevAIEngine` — auto-replying fake engine for `bun run dev:test`.
 *
 * Wraps the behavior-test {@link FakeAIEngine} (which is otherwise
 * driven by an HTTP side-channel from the test driver) and front-runs
 * every `spawn`/`resume` with a canned script of EngineEvents so the
 * chat composer actually returns *something* in the dev TUI without a
 * real `claude` binary in the loop.
 *
 * Lives in `src/engine/` (not `test/`) because it's a product affordance
 * for development, not a test fixture. The behavior-test FakeAIEngine
 * is still imported as the underlying queue/iterator implementation —
 * no point reimplementing the queue/waiter plumbing.
 *
 * Sequencing: events fire on a 30ms tick so the user can watch the
 * stream render incrementally instead of seeing the full reply slam in
 * on a single frame. Tweakable via the optional constructor arg.
 */

import { FakeAIEngine } from "../../test/behavior/fake-engine.ts"
import type {
  AIEngine,
  EngineCapabilities,
  EngineEvent,
  EngineHistory,
  EngineIdentity,
  SessionHandle,
  SessionMeta,
  SpawnOpts,
} from "../types/engine.ts"
import { claudeCapabilities, claudeIdentity } from "./claude-code-local/capabilities.ts"
import { listClaudeCommands } from "./claude-code-local/commands.ts"

export interface DevAIEngineOpts {
  /** Delay between successive scripted events. Defaults to 30ms. */
  readonly tickMs?: number
}

export class DevAIEngine implements AIEngine {
  /** Dev fake impersonates claude — borrow its capabilities. */
  readonly identity: EngineIdentity = claudeIdentity
  readonly capabilities: EngineCapabilities = claudeCapabilities
  private readonly inner = new FakeAIEngine()
  private readonly tickMs: number

  constructor(opts: DevAIEngineOpts = {}) {
    this.tickMs = opts.tickMs ?? 30
  }

  async spawn(cwd: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    const handle = await this.inner.spawn(cwd, prompt, opts)
    this.scheduleCannedReply(handle.sessionId, prompt, opts)
    return handle
  }

  async resume(sessionId: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    const handle = await this.inner.resume(sessionId, prompt, opts)
    this.scheduleCannedReply(handle.sessionId, prompt, opts)
    return handle
  }

  stream(handle: SessionHandle): AsyncIterable<EngineEvent> {
    return this.inner.stream(handle)
  }

  async readHistory(sessionId: string): Promise<EngineHistory> {
    return this.inner.readHistory(sessionId)
  }

  async deleteHistory(sessionId: string): Promise<void> {
    return this.inner.deleteHistory(sessionId)
  }

  async listSessions(cwd: string): Promise<SessionMeta[]> {
    return this.inner.listSessions(cwd)
  }

  async listCommands(opts?: { cwd?: string }) {
    return listClaudeCommands(opts?.cwd)
  }

  async stop(handle: SessionHandle): Promise<void> {
    return this.inner.stop(handle)
  }

  /**
   * Pump a canned reply onto the scripted queue. Echoes the user's
   * prompt back inside the assistant text so the dev can see the
   * round-trip happened, then a fake usage record + done. Permission
   * mode `plan` triggers a synthetic plan-mode reply (markdown
   * outline) so the approve-plan widget appears.
   */
  private scheduleCannedReply(sessionId: string, prompt: string, opts: SpawnOpts | undefined): void {
    const planMode = opts?.permissionMode === "plan"
    const events: EngineEvent[] = planMode ? buildPlanModeReply(prompt) : buildAssistantReply(prompt)

    let i = 0
    const tick = () => {
      const ev = events[i++]
      if (!ev) return
      this.inner.script(sessionId, [ev])
      if (i < events.length) setTimeout(tick, this.tickMs)
    }
    setTimeout(tick, this.tickMs)
  }
}

function buildAssistantReply(prompt: string): EngineEvent[] {
  const trimmed = prompt.trim().slice(0, 120)
  const echo = trimmed.length === 0 ? "(empty prompt)" : trimmed
  // Chunks intentionally exercise every Markdown shape the chat-pane
  // renderer supports so `bun run dev:test` doubles as a visual smoke:
  // KOB-28 (heading / ordered list / blockquote / link) on top of the
  // older bold / italic / inline-code / bullet / fenced-code paths, plus
  // KOB-47 (table / task list / horizontal rule / bare-URL autolink).
  const chunks = [
    "# Mock reply\n\n",
    "Got it — I read your prompt as: ",
    `“${echo}”.\n\n`,
    "This is a **`dev:test`** mock response. _No real Claude was invoked._\n\n",
    "## What just happened\n\n",
    "1. The fake engine streamed a handful of deltas\n",
    "2. Then a usage frame\n",
    "3. Then a `done` so the composer unlocks\n\n",
    "### Bullet sanity\n\n",
    "- inline code: `cleanChatText`\n",
    "- a [link to claude](https://claude.com)\n",
    "- bare URL: visit https://opentui.dev for docs.\n\n",
    "### Task list\n\n",
    "- [x] parse markdown blocks\n",
    "- [x] render tables with box-drawing\n",
    "- [ ] syntax-highlight code fences\n",
    "- [ ] wrap inside table cells\n\n",
    "---\n\n",
    "### Table\n\n",
    "| Feature | Status | Notes |\n",
    "| :--- | :---: | ---: |\n",
    "| Tables | ✓ | GFM, with `:---` alignment |\n",
    "| Task lists | ✓ | `[x]` / `[ ]` |\n",
    "| Strikethrough | — | disabled, conflicts with `~100` |\n\n",
    "> Block quotes look like this — useful when the model cites itself.\n\n",
    "```ts\nexport const ok = true\n```\n",
  ]
  const events: EngineEvent[] = chunks.map((text) => ({ type: "assistant.delta", text }))
  events.push({ type: "usage", input_tokens: 42, output_tokens: 87 })
  events.push({ type: "done" })
  return events
}

function buildPlanModeReply(prompt: string): EngineEvent[] {
  const echo = prompt.trim().slice(0, 80) || "(empty prompt)"
  // Synthesise an ExitPlanMode tool call so the chat pane renders the
  // approve-plan widget. The orchestrator promotes any `tool.start`
  // named `ExitPlanMode` into a user-input request.
  return [
    { type: "assistant.delta", text: "Plan mode mock — drafting an outline.\n" },
    {
      type: "tool.start",
      name: "ExitPlanMode",
      input: {
        plan: `# Plan for: ${echo}\n\n1. Inspect the relevant files\n2. Sketch the change\n3. Apply it\n4. Verify with the test suite\n`,
      },
    },
    { type: "tool.result", name: "ExitPlanMode", output: { ok: true } },
    { type: "usage", input_tokens: 50, output_tokens: 60 },
    { type: "done" },
  ]
}
