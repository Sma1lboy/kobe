# kobe (codename, rename later)

Goal: build a TUI that mimics Conductor's UX (multi-task AI orchestration), with Claude Code as the engine.

**Read in order before doing anything**:
1. [`HANDOFF.md`](./HANDOFF.md) — the briefing from the very first session.
2. [`docs/DESIGN.md`](./docs/DESIGN.md) — design philosophy, architecture, tech stack lock-in.
3. [`docs/PLAN.md`](./docs/PLAN.md) — Phase 0 → Phase 1 stream/wave plan.
4. [`docs/HARNESS.md`](./docs/HARNESS.md) — agent self-test contract. **Load-bearing.**

The architecture decisions are not obvious from the code (the code is mostly empty). The docs are the source of truth.

## Conventions

- `refs/` contains study material (symlinks + clones), **gitignored**. **Never edit anything inside `refs/`.**
- The user's name is Jackson (sma1lboy). Respond in the language they use (Chinese or English).
- Tech stack is locked: **TypeScript + `@opentui/core` + `@opentui/solid` + Solid.js + Bun**. Do not re-litigate.

## Reference repos — clone before development

kobe is built by deliberately copying ideas (and sometimes code) from four reference projects. New devs / agents must have all four cloned into `refs/` before touching the codebase. Run the setup block below; agents who skip this miss design context that's not derivable from the kobe source alone.

| `refs/` slot | Source | Borrowed surface |
|---|---|---|
| `agent-deck` | [`/Users/jacksonc/i/agent-deck`](https://github.com/sma1lboy/agent-deck) (symlink) | **TUI visual style + layout grammar.** Pane chunking, agent-deck-style `[Tab] label` chip hotkeys, BOLD CAPS pane headers, status-line bottom bar, focused-pane border highlighting. When in doubt about how a pane should look, open `agent-deck` and look at how it solves the same problem. |
| `conductor` (image only) | screenshots Jackson supplied | **Layout + product capability brief.** The 5-pane Conductor screenshot in `docs/DESIGN.md` §1 is the layout grammar. We don't have source access; we copy the chunking + capability set (multi-task, history sidebar, file tree, terminal, chat). Direction shifting per-session — see HANDOFF.md. |
| `opcode` | fresh clone of [`winfunc/opcode`](https://github.com/winfunc/opcode) | **How to spawn + stream Claude Code as a subprocess.** kobe's `src/engine/claude-code-local/` was algorithmically ported from opcode's `src-tauri/src/commands/claude.rs` (subprocess spawn + stream-json parser + JSONL reader + binary discovery). When extending the engine, port from opcode first. |
| `claude-code` | fresh clone of [`tanbiralam/claude-code`](https://github.com/tanbiralam/claude-code) (leaked Anthropic source, March 2026) | **Match Claude Code's exact stream rendering style.** Has `src/ink/` (the Ink-based TUI components, layout, events). When implementing how the stream output looks (assistant text formatting, tool call display, thinking dots, code blocks, citations), mirror Claude Code's choices so kobe feels like Claude Code, not a third-party shell. |

### Setup before developing (clone all four)

```bash
mkdir -p refs && cd refs
ln -s /Users/jacksonc/i/agent-deck agent-deck   # if you have it locally
git clone --depth 1 https://github.com/winfunc/opcode.git
git clone --depth 1 https://github.com/tanbiralam/claude-code.git
# `conductor` is image-only — read docs/DESIGN.md §1 for the layout
```

`refs/` is gitignored, so each environment clones for itself. CI / agent runs that need ref reading should mirror this setup or surface a missing-ref error, not silently proceed with partial context.

### When to consult which ref

- "How should this pane look?" → `agent-deck`.
- "What feature is missing from kobe vs Conductor?" → `docs/DESIGN.md` §1 + Jackson's screenshots.
- "How do I spawn / parse / resume a Claude Code session?" → `opcode/src-tauri/src/commands/claude.rs`.
- "How does Claude Code render <X>?" (where X = stream content, tool call display, prompt formatting, etc.) → `claude-code/src/ink/`.

If a ref disagrees with kobe's existing implementation, kobe wins (we already chose) — but read the ref before deciding to deviate further.

## Operating model — agent teams + self-validation

This project does not run on solo subagents. It runs on **teams** of agents that self-validate.

### Team mode (canonical)

- Related streams group into a **team** (e.g. Foundation Team = streams 0.2 + 0.3 + 0.4).
- Each team member runs in its own git worktree (`isolation: "worktree"`) to prevent cross-pollution.
- Each member commits independently in its worktree branch.
- The orchestrator (the main Claude Code session) merges the branches back to `main` only after every member is green.
- Teammates don't edit files outside their slice. If they need a change there, they surface — they don't unilaterally widen scope.
- A team is **done** when every member commits green and the merge lands.

The named teams so far (see `docs/PLAN.md` for full breakdowns):
- **Foundation Team** — streams 0.2, 0.3, 0.4. Lifts the opencode shell, defines core types, builds the behavior test harness.
- **Wave 1 Team** — streams A, B, C, D. Engine impl, worktree manager, task index, theme/keybindings.
- **Wave 3 Team** — streams G, H, I, J. The four panes that flank the chat.

Sequential stages (0.1, E, F, K, L, M) are run as solo agents — but still under the same harness contract.

### Agent self-validation (the rule that matters)

> Tests are not just typecheck and `bun test`. **Tests include the agent running the actual product end-to-end and asserting visible behavior.** No human is in the loop for verification.

Concretely, every stream that produces a user-visible change must include a **behavioral self-test**:

1. The agent spawns kobe (or a stream-scoped subset) under PTY/tmux via the Stream 0.4 driver.
2. Sends keystrokes as a real user would.
3. Captures the visible screen.
4. Asserts on visible state (text, layout, status badges).

If the agent only ran `bun typecheck` and `bun test`, it has not validated the work. It has validated some functions. The bar is: *the agent has proven, by running the binary, that the product behaves correctly.* Without that proof, no commit.

Full contract is in `docs/HARNESS.md`. Read it before spawning any team.

### What surfaces to the human (Jackson)

Bring to Jackson only:
- Architectural decisions not in DESIGN.md.
- 3-strike blockers (three failed fixes on the same root cause).
- Cross-stream conflicts that need scope adjudication.
- Wave-gate sign-offs (G0, G1, G2, G3, G4).
- Intentional deviations from PLAN.md.

Do not bring:
- Routine compiler errors.
- "Did this commit go through?" — check with `git log` first.
- Whether to run `bun install`. Just run it.
- File-naming choices within stream scope.

## Hard rules (non-negotiable)

### Commits

- Commit at the end of each stream when the agent is green. The user has authorized per-stream commits in advance.
- Commit message: `<type>: <stream id> — <one-line summary>` plus a 2-3 sentence body.
- **NEVER** include `Co-Authored-By: Claude` or any AI/Anthropic/Claude attribution. No "Generated with Claude Code" footers. (From the workspace-level `/Users/jacksonc/i/CLAUDE.md`.)
- **NEVER** use `--no-verify`, `--no-gpg-sign`, or skip hooks. If a hook fails, fix the underlying issue.

### Deletion

- **NEVER** delete files, branches, worktrees, or run `rm -rf` unless the user explicitly says "delete" or "remove" *in the same conversation turn*.
- This includes: cleanup of stale worktrees, "fixing" the layout by removing files, anything destructive.
- If a task seems to require deletion, surface and ask first.

### Scope

- A stream agent only edits files within its declared slice. Cross-stream changes are surfaced, not silently made.
- 3-strike rule: same root cause failed three times → stop and surface.
- Max-depth rule: 3+ levels of sub-investigation → surface findings before going deeper.

### Don't touch

- `refs/` — study material, read-only forever.
- Other agents' worktree slices — coordinate via the orchestrator.
- Workspace-level config (`/Users/jacksonc/i/CLAUDE.md`, global git config, etc.).

### Layout: flex-first, hardcode last

opentui boxes follow Yoga flexbox semantics. Default to flex flow (`flexGrow`, `flexShrink`, `flexBasis`, `flexDirection`) for sizing — let panes share available terminal width by ratio, not by pixel-count. Hardcoded `width={N}` / `height={N}` is acceptable only when:

- **Convention** — e.g. the sidebar's 42-cell width matches opencode/agent-deck precedent for "history rail" pane. Document the reason inline.
- **Terminal-grammar fixed glyph** — e.g. a 2-cell column for diff-line `+`/`-` markers.
- **Modal or transient overlay** — dialogs centered with computed dimensions.

Never use `width={N}` / `height={N}` to express "this pane should be this big proportionally." Use `flexGrow={N}` for that. Avoid `height="100%"` — `flexGrow={1}` does the same thing without surprising clipping when the parent doesn't have an explicit height.

If you find yourself reaching for a magic constant: pause, and verify a flex prop wouldn't do the same thing.

## Phase status

- **Phase 0**: foundation. Streams 0.1 (bootstrap, solo), then Foundation Team (0.2 + 0.3 + 0.4) in parallel. **Closed.**
- **Phase 1**: build the 5-pane Conductor-shaped TUI. Waves 1–4 per `docs/PLAN.md`. **Closed at gate G4 on 2026-05-09 — shipped as `@sma1lboy/kobe@0.1.0` on npm.** See [`CHANGELOG.md`](./CHANGELOG.md) for the 0.1.0 feature manifest.
- **Phase 2**: deferred. Conductor-as-backend mode. Hook points designed in; impl not yet.

Update this section's status as gates G0–G4 close. See PLAN.md for the canonical state.

### Closed follow-ups from 0.1.0

- Approval-flow regressions resolved (commit `0c73ebb`): the
  AskUserQuestion "crash" was a UTF-8 byte/char mismatch in the test
  helper's `Content-Length` header (em-dash in the question payload),
  not a kobe crash. The composer-lock failure was an over-strict test
  assertion — opentui's text wrapper drops the space at a wrap point,
  so the rendered placeholder is `answerthe promptabove to continue`.
  Both `test/behavior/approval-flow.test.ts` cases now run.
- CI gate: `.github/workflows/ci.yml` runs typecheck + unit tests + build
  on every push to main and every PR. Behavior tests stay local-only
  (need tmux + node-pty terminal sizing).
