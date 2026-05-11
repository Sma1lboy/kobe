# kobe (codename, rename later)

Goal: build a TUI that mimics Conductor's UX (multi-task AI orchestration), with Claude Code as the engine.

**Read in order before doing anything**:
1. [`HANDOFF.md`](./HANDOFF.md) — the briefing from the very first session.
2. [`docs/DESIGN.md`](./docs/DESIGN.md) — design philosophy, architecture, tech stack lock-in.
3. [`docs/PLAN.md`](./docs/PLAN.md) — Phase 0 → Phase 1 stream/wave plan.
4. [`docs/HARNESS.md`](./docs/HARNESS.md) — agent self-test contract. **Load-bearing.**
5. [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md) — pane-scope rules + boundary patterns. Read before adding/moving any chord.

The architecture decisions are not obvious from the code (the code is mostly empty). The docs are the source of truth.

## Conventions

- **Monorepo layout (Bun workspaces).** Source lives under `packages/`:
  - [`packages/kobe/`](./packages/kobe) — the TUI itself, published as `@sma1lboy/kobe`. All `src/...`, `test/...`, `scripts/...` paths in docs are relative to here.
  - [`packages/branding/`](./packages/branding) — Remotion render pipeline for `docs/assets/brand/`. Private workspace.
  - Run package scripts via `bun --filter @sma1lboy/kobe <script>` or `cd packages/kobe && bun <script>`.
  - Repo-wide tools at root: `biome.json`, `bun.lock`, `.github/workflows/`, `docs/`, `CLAUDE.md`, `HANDOFF.md`.
- `refs/` contains study material (symlinks + clones), **gitignored**. **Never edit anything inside `refs/`.**
- Respond in whatever language the current user is writing in. Don't assume their name — let them introduce themselves.
- Tech stack is locked: **TypeScript + `@opentui/core` + `@opentui/solid` + Solid.js + Bun**. Do not re-litigate.

## Reference repos — clone before development

kobe is built by deliberately copying ideas (and sometimes code) from four reference projects. New devs / agents must have all four cloned into `refs/` before touching the codebase. Run the setup block below; agents who skip this miss design context that's not derivable from the kobe source alone.

| `refs/` slot | Source | Borrowed surface |
|---|---|---|
| `agent-deck` | [`/Users/jacksonc/i/agent-deck`](https://github.com/sma1lboy/agent-deck) (symlink) | **TUI visual style + layout grammar.** Pane chunking, agent-deck-style `[Tab] label` chip hotkeys, BOLD CAPS pane headers, status-line bottom bar, focused-pane border highlighting. When in doubt about how a pane should look, open `agent-deck` and look at how it solves the same problem. |
| `conductor` (image only) | screenshots Jackson supplied | **Layout + product capability brief.** The 5-pane Conductor screenshot in `docs/DESIGN.md` §1 is the layout grammar. We don't have source access; we copy the chunking + capability set (multi-task, history sidebar, file tree, terminal, chat). Direction shifting per-session — see HANDOFF.md. |
| `opcode` | fresh clone of [`winfunc/opcode`](https://github.com/winfunc/opcode) | **How to spawn + stream Claude Code as a subprocess.** kobe's `packages/kobe/src/engine/claude-code-local/` was algorithmically ported from opcode's `src-tauri/src/commands/claude.rs` (subprocess spawn + stream-json parser + JSONL reader + binary discovery). When extending the engine, port from opcode first. |
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

## Issue tracking — Linear

kobe **code-level** work is tracked in Linear. The Linear project is the product scoreboard — what's been built and what's queued; commit history is the proof.

| | |
|---|---|
| Workspace | [`codesfox`](https://linear.app/codesfox) |
| Team | `KOB` (Kobe) |
| Active project | `Pre-1.0 整理` |
| Workspace labels | `Bug`, `Chore`, `Doc`, `Feature`, `Featurebase`, `Tech Debt` |

### What to file

**File:** features, bug fixes, refactors, product follow-ups, design decisions that change what kobe *does*.

**Don't file:** tool/process/meta work — CLAUDE.md edits, `.claude/skills/...` rewrites, memory tweaks, agent config, dev-env setup. Linear is not a meta-changelog.

Litmus test: *does this change kobe's behavior, code, or product surface?* Yes → file. No → skip.

### Lifecycle

1. **File** when the work starts (or when a forward requirement surfaces in chat).
2. **Do the work** — code, test, harness self-validation.
3. **Mark Done** the moment it lands: `linear issue update KOB-N --state Done`.
4. **Link the commit** — either reference `KOB-N` in the commit message (Linear's GitHub integration auto-links) or attach a comment with the SHA via `linear issue comment add KOB-N --body-file ...`.

Exception to "mark Done immediately": forward requirements ("we'll need X eventually") stay open in `Todo` / `Backlog` until actually picked up.

### Tooling — `linear` CLI, not MCP

We use [`schpet/linear-cli`](https://github.com/schpet/linear-cli), not the Linear MCP server. The MCP path was flaky; the CLI is `brew`-installed, scriptable, and authenticated once via system keyring.

**Install + auth (one-time per dev / per agent host):**

```bash
brew install schpet/tap/linear-cli   # or whatever your platform's install path is
linear auth login                     # interactive browser OAuth — user must do this
linear auth whoami                    # verify: should print Workspace + User
```

Agents who find `linear` missing on PATH should surface to the user — do not try to fall back to the MCP, and do not silently skip filing.

### Cheat sheet

```bash
# Create
cat > /tmp/issue-body.md <<'EOF'
<markdown body — context, scope, open questions>
EOF
linear issue create \
  --team KOB --project "Pre-1.0 整理" \
  --title "<short imperative title>" \
  --description-file /tmp/issue-body.md \
  --label "Feature" --no-interactive

# Close on completion
linear issue update KOB-N --state Done
linear issue comment add KOB-N --body-file /tmp/done-note.md   # commit SHA goes here
```

Notes:
- `--no-interactive` is a **create-only** flag. `update` has no such flag — just pass the change directly.
- Always use `--description-file` / `--body-file` for any markdown body — `-d "..."` / `-b "..."` mangles newlines and shell-quoting.
- Surface the issue URL after every create / state change.

Full skill at [`.claude/skills/linear/SKILL.md`](./.claude/skills/linear/SKILL.md).

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

### Diagrams in `docs/`: use Mermaid

When a `docs/` markdown file needs a diagram (entity relationships, state machines, lifecycles, sequence flows), use **Mermaid** in a ` ```mermaid ` fence rather than ASCII art.

Why Mermaid and not PlantUML / vega / canvas / etc.: Mermaid renders **natively in GitHub README, GitHub PR previews, and VS Code's built-in markdown preview** — zero plugins, zero servers. PlantUML and the other markdown-viewer formats need a browser extension or a local renderer, which means most viewers see a code block of unrendered source. Diagrams should be legible to anyone clicking a `.md` link in the repo.

ASCII boxes are fine for tiny relationships (≤3 nodes, no states), but rot the moment a state or arrow is added. When in doubt, reach for Mermaid.

Canonical example: [`docs/design/tasks.md`](./docs/design/tasks.md) — `classDiagram` for the Task / Worktree / ChatTab triple, `stateDiagram-v2` for the tab and task lifecycles.

## Phase status

- **Phase 0**: foundation. Streams 0.1 (bootstrap, solo), then Foundation Team (0.2 + 0.3 + 0.4) in parallel. **Closed.**
- **Phase 1**: build the 5-pane Conductor-shaped TUI. Waves 1–4 per `docs/PLAN.md`. **Closed at gate G4 on 2026-05-09 — shipped as `@sma1lboy/kobe@0.1.0` on npm.** See [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md) for the 0.1.0 feature manifest. Post-1.0 line continues there — current published version is **`0.5.0` (2026-05-10)**, which folds in the daemon multi-attach broadcast (KOB-36), richer assistant markdown (KOB-47), clipboard / cmd-key fixes (KOB-48), the `@`-mention file picker, image-paste prettify in the transcript, and a file-tree viewport that follows the cursor. `v0.4.0` introduced the context-usage meter in the WORKSPACE header. (Note: `0.2.x → 0.4.x → 0.5.0` because `0.3.0` was only documented, never tagged.)
- **Phase 2**: dropped 2026-05-09. Originally a defensive hedge for "what if we ever swap engines." No real product driver — kobe's value is the UI, the local `claude` subprocess works, and Anthropic's API already covers shared/cloud sessions. Free up the design space; revisit only if a concrete engine-swap need surfaces.

Update this section's status as gates G0–G4 close. See PLAN.md for the canonical state.

### Closed follow-ups from 0.1.0

- Approval-flow regressions resolved (commit `0c73ebb`): the
  AskUserQuestion "crash" was a UTF-8 byte/char mismatch in the test
  helper's `Content-Length` header (em-dash in the question payload),
  not a kobe crash. The composer-lock failure was an over-strict test
  assertion — opentui's text wrapper drops the space at a wrap point,
  so the rendered placeholder is `answerthe promptabove to continue`.
  Both `packages/kobe/test/behavior/approval-flow.test.ts` cases now run.
- CI gate: `.github/workflows/ci.yml` runs typecheck + unit tests + build
  on every push to main and every PR. Behavior tests stay local-only
  (need tmux + node-pty terminal sizing).
