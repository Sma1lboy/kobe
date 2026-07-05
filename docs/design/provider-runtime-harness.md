# Provider-runtime harness exploration

> Status: exploration note, not a decision. 2026-07-03.
> Audience: future kobe direction work, especially if kobe revisits a no-tmux
> architecture after the v0.6 tmux-handover reshape.

## Summary

AI SDK 7's harness layer validates a provider-shaped way to consume agent
runtimes instead of model providers. The product does not call an LLM directly;
it calls a runtime such as Codex, Claude Code, OpenCode, Deep Agents, or Pi.
That runtime owns model calls, tool loops, session history, workspace access,
compaction, native tools, and parts of the permission model. The host app gets a
normalized stream/result shape back.

For kobe, the interesting part is not Vercel's exact API. The useful product
shape is:

```txt
kobe product layer
  -> runtime provider seam
     -> codex / claude-code / opencode / deepagents / pi / custom
        -> runtime-owned model calls, tools, auth, sessions
```

This is closer to "bring your own agent runtime" than "bring your own model
key".

## Why this matters for kobe

The v0.6 tmux direction exists because interactive engine CLIs are already
products. They own auth, model selection, approvals, tools, and local session
state. kobe chose to hand over the real terminal instead of rebuilding those
surfaces or routing every turn through a headless API.

Provider-runtime harnesses reopen the no-tmux question. If Codex / Claude Code /
OpenCode expose structured runtime APIs with usable streaming, session control,
tool/file-change events, and local auth reuse, kobe can keep the same core
principle without tmux:

```txt
do not own the LLM layer
do not own the agent loop
own task/worktree/session/product orchestration
```

The no-tmux version is not a return to the old v0.5 model-provider loop. It
would be a direct runtime-provider integration where kobe embeds or drives an
agent runtime and renders its structured events itself.

## Working mental model

Traditional AI SDK style:

```txt
kobe -> model provider -> LLM API -> kobe-owned tool loop
```

Current tmux-handover style:

```txt
kobe -> tmux Session -> interactive Codex/Claude Code CLI
```

Provider-runtime style:

```txt
kobe -> RuntimeProvider -> Codex/Claude Code runtime -> normalized event stream
```

The last shape preserves the most important property of tmux-handover: the
runtime, not kobe, owns the LLM calls and the agent loop.

## Auth and billing boundary

This must be treated as a runtime-auth problem, not a kobe API-key form.

For a local product, kobe can plausibly detect installed agent tools and offer
them as runtime backends:

- Codex installed and signed in.
- Claude Code installed and signed in.
- OpenCode installed and configured.
- Otherwise fall back to an explicit API key / gateway / custom runtime.

In that local shape, the user experience can become "use my existing local
agent runtime" instead of "paste provider keys into kobe".

For hosted execution, this does not automatically use the user's local
subscription. Hosted runs need their own auth path: API key, AI Gateway, OIDC,
access token, workspace token, or a local relay. Do not blur these two modes.

## Feasibility read

Feasible enough to preserve as a direction:

- AI SDK 7 now treats harness adapters as the agent-runtime equivalent of model
  providers.
- Official adapters already exist for Codex, Claude Code, OpenCode, Deep Agents,
  and Pi.
- The adapter contract normalizes sessions, stream events, tools, usage,
  lifecycle state, skills, and configuration.
- This matches kobe's desired ownership split: kobe owns tasks, worktrees,
  status, UI, persistence, and cross-session workflow; the runtime owns the
  model loop.

Not proven yet:

- Whether each local SDK path can reuse the same user-facing subscription/login
  state as the interactive CLI.
- Whether the event stream is rich enough for kobe's UI without falling back to
  terminal scraping.
- Whether approval flows, interruption, resume, and file-change events are
  stable across Codex and Claude Code.
- Whether a runtime-provider backend can cover the same terminal-native affordances
  that made tmux attractive.

## Pi as a concrete runtime-provider case

Pi is useful because it exposes the idea directly instead of only through an
interactive CLI. Its package split maps cleanly to the runtime-provider shape:

```txt
@earendil-works/pi-agent-core
  -> low-level agent runtime, tool calling, state management

@earendil-works/pi-coding-agent
  -> coding-agent product layer: CLI, SDK, tools, sessions, skills, extensions

@ai-sdk/harness-pi
  -> Vercel AI SDK adapter around @earendil-works/pi-coding-agent
```

For a kobe spike, `@earendil-works/pi-coding-agent` is the first package to
try. Its SDK exposes `createAgentSession()`, `session.prompt()`,
`session.subscribe()`, session management, model control, skills, context files,
custom tools, print/json mode, and RPC mode. That is closer to the no-tmux
runtime-provider seam than a terminal-only CLI.

Vercel's Pi harness adapter confirms the same shape from the outside:

```txt
AI SDK HarnessAgent
  -> @ai-sdk/harness-pi
     -> @earendil-works/pi-coding-agent
        -> Pi runs in the host Node.js process
        -> sandbox is used as remote filesystem + shell
```

This differs from the Codex and Claude Code harness adapters, which run a bridge
inside the sandbox and stream events back over a sandbox-exposed channel. Pi's
host-process design may be easier to embed locally, but it also shifts more
trust and isolation work onto kobe.

Important caveat: Pi does not provide a strong built-in sandbox/permission
boundary. By default it runs with the permissions of the launching user/process.
If kobe uses Pi as a runtime provider, kobe must still own or select the
execution boundary: container, micro-VM, policy-controlled shell, or a narrow
tool set.

## Candidate kobe seam

If this direction is spiked, avoid naming it after Vercel's `HarnessAgent`.
Name the local concept around what kobe owns:

```ts
type RuntimeProviderId =
  | "codex"
  | "claude-code"
  | "opencode"
  | "deepagents"
  | "pi"
  | "custom";

interface RuntimeProvider {
  id: RuntimeProviderId;
  detect(): Promise<RuntimeProviderStatus>;
  createSession(input: RuntimeSessionInput): Promise<RuntimeSession>;
  readHistory(input: RuntimeHistoryInput): Promise<RuntimeHistory>;
  readUsage(input: RuntimeUsageInput): Promise<RuntimeUsage>;
}

interface RuntimeSession {
  send(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent>;
  continue(input?: RuntimeContinueInput): AsyncIterable<RuntimeEvent>;
  stop(): Promise<RuntimeResumeState | undefined>;
  destroy(): Promise<void>;
}
```

The key is that `RuntimeEvent` should describe agent-runtime events, not raw
terminal bytes:

- text deltas
- reasoning summaries
- tool calls/results
- file changes
- approval requests/responses
- usage
- finish/error
- compaction/resume events

Terminal capture is a fallback transport, not the abstraction.

## Spike checklist

Before changing kobe architecture, run a narrow local spike:

1. Codex: create a worktree-backed session, send a prompt, stream structured
   events, continue the same session, and verify whether local ChatGPT/Codex
   login can be reused without an API key.
2. Claude Code: same test through the official/local SDK path, including
   approval/interruption behavior.
3. Pi: create a `@earendil-works/pi-coding-agent` SDK session in a worktree,
   subscribe to events, send a prompt, and inspect whether event granularity is
   rich enough to render kobe-native task status without terminal capture.
4. Compare direct Pi SDK integration with `@ai-sdk/harness-pi` to decide
   whether kobe wants the AI SDK compatibility layer or a thinner local adapter.
5. Render one runtime stream in a minimal kobe pane without tmux capture.
6. Prove file-change events are good enough for task status and diff surfaces.
7. Prove session resume survives process restart.
8. Document billing/auth source for every backend: local subscription, API key,
   gateway, or unsupported.

If those pass, the next kobe architecture can be "task/worktree daemon plus
runtime providers" instead of "task/worktree daemon plus tmux sessions".

## Decision boundary

This note does not obsolete the current tmux architecture. It records why a
no-tmux direction is worth re-evaluating after official provider-like harnesses
appeared.

Keep tmux as the known-good path until a runtime-provider spike proves:

- structured streams replace terminal capture,
- local auth/subscription reuse is real for the target runtime,
- approvals and resume are product-grade,
- kobe can still stay local-first and terminal-friendly without owning the LLM
  layer.

## References

- AI SDK Harnesses overview: https://ai-sdk.dev/docs/ai-sdk-harnesses/overview
- AI SDK Harness Adapters: https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters
- Codex harness docs: https://ai-sdk.dev/providers/ai-sdk-harnesses/codex
- Pi harness docs: https://ai-sdk.dev/providers/ai-sdk-harnesses/pi
- Pi repo: https://github.com/earendil-works/pi
- Pi SDK docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- Vercel AI SDK 7 changelog: https://vercel.com/changelog/ai-sdk-7
