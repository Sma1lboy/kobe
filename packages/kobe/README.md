<p align="center">
  <img src="docs/assets/brand/bracket-chip.gif" alt="kobe" width="720" />
</p>

<p align="center">
  <strong>One terminal, many Claude Code sessions.</strong><br/>
  kobe is a TUI that runs N Claude Code agents in parallel — each in its own git worktree — so you can drive a small team of tasks from one screen.
</p>

<p align="center">
  <em>Codename — will be renamed before any non-beta release.</em>
</p>

---

## What kobe is

A terminal UI on top of the `claude` CLI. It gives you a Conductor-shaped layout
(sidebar of tasks, workspace pane with chat + file tabs, file tree, embedded
terminal, status bar) and runs each task in its own isolated git worktree, so
multiple Claude Code sessions can edit the same repo at the same time without
stepping on each other.

If you've used a single `claude` session and wished you could fan out to five,
that's the gap kobe fills.

## Install

[![npm](https://img.shields.io/npm/v/%40sma1lboy%2Fkobe.svg)](https://www.npmjs.com/package/@sma1lboy/kobe)

You need two things on `PATH`:

- [**Bun**](https://bun.sh) ≥ 1.0 — kobe's renderer is opentui, which uses Bun-FFI.
- [**`claude`** CLI](https://docs.anthropic.com/en/docs/claude-code) — the engine kobe drives. Run `claude --version` to confirm it's installed and signed in.

Then:

```bash
bun install -g @sma1lboy/kobe
kobe
```

Or run without installing:

```bash
bunx @sma1lboy/kobe
```

The first launch drops you into an empty sidebar — press `n` to create your
first task. kobe will ask for a repo path and a base branch, then spin
up a worktree at `<repo>/.claude/worktrees/<task-id>/` and a chat pane
talking to a fresh `claude` session inside it.

## A glimpse

<p align="center">
  <img src="docs/assets/brand/pane-grid.gif" alt="kobe pane layout" width="720" />
</p>

## What you can do

Once you're in, the keys you'll use most:

| Key                | What it does                                                   |
| ------------------ | -------------------------------------------------------------- |
| `ctrl+h` / `ctrl+j` / `ctrl+k` / `ctrl+l` | Jump straight to a pane (sidebar, workspace, files, terminal) |
| `tab`              | Cycle focus to the next pane                                   |
| `ctrl+q`           | Detach back to the sidebar (your task keeps streaming)         |
| `ctrl+o`           | Open the active task's worktree in your editor                 |
| `F1`               | Show the full keybinding help dialog                           |
| `ctrl+,`           | Open Settings (theme, transparent background, dev reset)       |
| `q`                | Quit (with confirm)                                            |

Inside the sidebar, with a task highlighted: `n` creates a task, `j/k` moves,
`enter` opens, `r` renames, `a` archives, `d` deletes, `s` opens Settings, and
`[` / `]` switches between the working session and the archives view.

Inside the chat composer:

- `enter` to send, `shift+enter` for a newline.
- `shift+tab` toggles the per-task tool-permission mode between `default` and `plan`. `default` is the trusted-bypass mode — kobe forwards it to `claude` as `--permission-mode bypassPermissions` because `claude -p` has no interactive permission protocol, so the only meaningful choice is "auto-deny outside cwd" or "auto-approve everything." `plan` forwards unchanged.
- Click the model label in the footer to pick the model for this task (opus / sonnet / haiku).
- Type `/` to open the slash-command dropdown. Bundled `claude-code` commands and your own `.claude/{commands,skills}/*.md` are merged in.
- A `Create PR` chip on the chat header injects a PR-instructions prompt into the active task and routes the resulting PR through the orchestrator.

A given task can host **multiple chat tabs** on the same worktree — useful when
you want a parallel sub-conversation without losing the main thread.

## Opening tasks in your editor

The top bar shows an `[Open] <editor>` chip when kobe can find an editor for the
active task. Click it, use `ctrl+o`, or run **Open task in editor** from the
command palette to open the task's worktree.

Detection order is:

1. `KOBE_OPEN_EDITOR`
2. `code` (VS Code)
3. `cursor`
4. `windsurf`
5. `zed`
6. platform fallback (`open` on macOS, `xdg-open` on Linux)

Set `KOBE_OPEN_EDITOR` globally if you want to force a specific tool:

```bash
export KOBE_OPEN_EDITOR=cursor
export KOBE_OPEN_EDITOR=code
export KOBE_OPEN_EDITOR=/Applications/Cursor.app/Contents/Resources/app/bin/cursor
```

For the full feature manifest, see [`CHANGELOG.md`](./CHANGELOG.md).

## Custom themes

kobe ships a handful of bundled themes (`claude` is the default), and any JSON
file you drop into `~/.kobe/themes/` is auto-loaded at boot and shows up in
Settings → Theme alongside the built-ins. Themes are publishable as raw JSON
on GitHub and installed with one command:

```bash
kobe theme add https://raw.githubusercontent.com/<you>/<repo>/main/<your-theme>.json
kobe theme list
kobe theme remove <name>
```

A JSON Schema at [`packages/kobe/src/tui/context/theme/theme.schema.json`](./src/tui/context/theme/theme.schema.json)
gives editor autocomplete — reference it via `"$schema"` in your theme file.

Full guide (shape, examples, GitHub publishing flow):
[`docs/themes.md`](../../docs/themes.md).

## Where things live

- Tasks: `~/.kobe/tasks.json`
- User themes: `~/.kobe/themes/*.json`
- Per-task worktrees: `<repo>/.claude/worktrees/<task-id>/`
- UI state (theme, sidebar widths, last-active task): kobe's KV store, also under `~/.kobe/`

## Troubleshooting

**`command not found: claude`** — kobe shells out to the `claude` CLI; install
it from [the Claude Code docs](https://docs.anthropic.com/en/docs/claude-code)
and confirm `claude --version` works in the same shell you launched kobe from.

**`bun: command not found`** — install [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).
kobe's renderer requires Bun ≥ 1.0; it does not run under Node.

**The terminal pane is blank** — kobe starts your `$SHELL` through Bun's native PTY. Confirm `$SHELL` points at an installed shell, your Bun version supports `Bun.spawn({ terminal })`, and the active task's worktree path still exists. `KOBE_TERMINAL_BACKEND=pipe` is available only as a fallback.

**Some shortcuts do not work inside tmux** — kobe asks opentui to enable the
kitty / CSI-u keyboard protocol, but tmux must pass those extended key
sequences through. Add this to `~/.tmux.conf`, then restart tmux:

```tmux
set -g extended-keys on
set -as terminal-features ',xterm*:extkeys'
set -as terminal-features ',tmux*:extkeys'
```

Your outer terminal still has to send the sequences. For iTerm2, enable
profile-level CSI-u key reporting. Terminal-app or macOS-level shortcuts can
still intercept Option/Cmd chords before tmux sees them; no tmux setting can
pass through a shortcut the terminal never forwards.

**`posix_spawnp failed` when running `bun run test:behavior`** — on macOS arm64,
Bun's installer occasionally ships `node-pty`'s prebuilt `spawn-helper` without
an exec bit. The behavior-test driver fixes it lazily on first spawn (see
`test/behavior/driver.ts`), so a re-run usually clears it. If not, run
`chmod +x node_modules/node-pty/build/Release/spawn-helper`.

**Worktree won't create** — kobe wants a clean git repo. The new-task dialog
validates the repo path before creating; if it's complaining, check that
`git status` runs cleanly inside the path you typed.

## Driving kobe from another agent

Inside kobe, the `claude` (or `codex`, etc.) you are talking to can call back
out and spawn more kobe tasks — useful when you ask it to "try three approaches
in parallel" instead of doing them sequentially in one chat. The mechanism is a
small CLI surface; design rationale lives in [`docs/design/cli-api.md`](../../docs/design/cli-api.md).

### Daemon lifecycle

A `kobe daemon` process holds your tasks and chat sessions. The TUI auto-starts
one on first launch; in scripts you may want to manage it explicitly.

```bash
kobe daemon start     # spawn detached, listen on the unix socket
kobe daemon status    # JSON status (pid, uptime, attached clients, task count)
kobe daemon restart   # graceful stop + start
kobe daemon stop      # tell the daemon to drain and exit
```

> Pre-0.6 builds shipped a separate `kobed` binary for the same commands. It
> was removed in favor of the single-bin surface (KOB-136); any script with
> `kobed restart` needs a one-time rename to `kobe daemon restart`.

### `kobe api <verb>` — five shell verbs

Each call is a short-lived process: open the daemon socket, do one RPC, print
JSON to stdout, exit. Any tool with a `Bash` capability (Claude Code, Codex,
Cursor, a custom agent) can drive it.

| verb | flags | what it does |
|---|---|---|
| `spawn-task` | `--repo PATH --prompt TEXT [--title T] [--base-branch B]` | Create a new task + worktree + chat session. |
| `create-tab` | `--task-id ID [--title T]` | Open an extra chat tab on an existing task. |
| `send`       | `--task-id ID --prompt TEXT [--tab-id TID]` | Resume the task's session with a new prompt. |
| `get-task`   | `--task-id ID` | Read task metadata (status, branch, worktree, tabs). |
| `get-tab`    | `--task-id ID --tab-id TID` | Read a single tab off the task. |

Output is one JSON object on stdout, `\n` terminated, exit 0. Errors land on
stderr as `{"error":{"message":"...","code":"..."}}` with a non-zero exit.
Add `--pretty` for human inspection.

Fan-out from a shell:

```bash
T1=$(kobe api spawn-task --repo "$PWD" --prompt "Approach A: state machine"   | jq -r .taskId)
T2=$(kobe api spawn-task --repo "$PWD" --prompt "Approach B: event sourcing"  | jq -r .taskId)
T3=$(kobe api spawn-task --repo "$PWD" --prompt "Approach C: reducer pattern" | jq -r .taskId)

# Tell the user three tasks are running — they'll appear in the sidebar.
echo "Spawned $T1 $T2 $T3"

# Poll until each settles.
for ID in $T1 $T2 $T3; do
  until [ "$(kobe api get-task --task-id "$ID" | jq -r .task.status)" = "idle" ]; do
    sleep 10
  done
done
```

If the daemon isn't running, `kobe api ...` exits 2 with
`{"error":{"code":"BAD_DAEMON",...}}` on stderr. Start it with
`kobe daemon start` (or just launch the TUI).

### Install the agent skill

`kobe api` gives the *capability*. The bundled SKILL.md gives the model the
*intent* — when to fan out, how to scope subtask prompts, how to read results
back. Install it once:

```bash
kobe skill install              # writes ~/.claude/skills/kobe/SKILL.md
kobe skill install --yes        # overwrite an existing copy
kobe skill uninstall            # remove it
```

After install, Claude Code automatically picks up the skill on its next launch.
For project-level overrides, copy the file to `<repo>/.claude/skills/kobe/SKILL.md`
and customise — Claude Code's discovery order is project > user > none.

`kobe diagnose` reports whether the skill is installed, which is the
fastest way to confirm.

## Coming later

- Homebrew tap (mirroring [`sma1lboy/homebrew-codefox`](https://github.com/sma1lboy/homebrew-codefox)) so you can `brew install kobe` without touching Bun directly.
- Conductor-as-backend mode (Phase 2 in [`docs/PLAN.md`](./docs/PLAN.md)).

---

## For contributors

If you want to hack on kobe itself rather than just use it:

```bash
bun install
bun run dev          # boots the 5-pane TUI under KOBE_DEV=1 (no update chip, etc.)
bun run test         # normal suite: fast tests + serial socket tests
bun run test:behavior  # slow PTY suite; only run for user-visible TUI behavior
bun run typecheck    # strict tsc
bun run build        # produces ./dist/cli/index.js for npm
```

Architecture, design philosophy, and the team-of-agents operating model live in:

- [`docs/DESIGN.md`](../../docs/DESIGN.md) — design philosophy, tech stack lock-in.
- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — module map and current state.
- [`docs/HARNESS.md`](../../docs/HARNESS.md) — the agent self-test contract.
- [`docs/PLAN.md`](../../docs/PLAN.md) — phase / wave plan.
- [`HANDOFF.md`](../../HANDOFF.md) — latest session state and follow-ups.

### Releasing

Bump `package.json`, move `## [Unreleased]` in `CHANGELOG.md` to the new
version section, commit, then push the matching `vX.Y.Z` tag. The release
workflow ([`.github/workflows/release.yml`](../../.github/workflows/release.yml))
runs typecheck + unit tests + build, asserts the tag matches `package.json`,
then `npm publish --provenance` and creates a GitHub release with the
changelog section as the body.
