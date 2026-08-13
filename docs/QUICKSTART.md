# Quick start

rove runs many AI coding sessions side by side in your terminal. Each one
gets its own git worktree and branch, so they never step on each other.

You need [Bun](https://bun.sh) ≥ 1.3.11, git, and at least one engine CLI
(`claude`, `codex`, or `copilot`) on your `PATH`.

## Install

```bash
bun install -g @sma1lboy/kobe

# or try it without installing
bunx @sma1lboy/kobe
```

## Your first task

```bash
cd your-repo
rove
```

Press `n`, pick a repo, a base branch, and an engine. Then just talk to the
session — it's the real engine CLI, running in a fresh worktree under
`~/.kobe/worktrees/`.

![Rove's three panes: tasks on the left, the engine session in the middle, changed files on the right](assets/workspace.png)

Three panes: **tasks** on the left, the **engine session** in the middle,
**changed files** on the right. Click any of them to focus it.

## Three keys to remember

| Key | What it does |
|---|---|
| `F1` | Every shortcut, live and up to date |
| `ctrl+a` | Opens the command menu |
| `ctrl+q` | Focus the sidebar — press it again to quit |

## Quitting doesn't stop anything

Sessions keep running in the background after you quit, close the terminal,
or drop an SSH connection. Run `rove` again and everything is where you left
it. When a background session finishes or needs you, Rove raises a desktop
notification and marks the task unread.

## Run many attempts at once

One prompt, N isolated attempts, one command:

![One prompt fans out to three tasks, each with its own worktree, engine session, and branch](assets/fan-out.png)

```bash
rove api fan-out --repo "$PWD" \
  --agents claude:2,codex:2 \
  --prompt "Try independent approaches to simplify the auth flow."
```

Compare the attempts, then land the winner:

```bash
rove api collect --task-ids a,b,c      # read-only comparison
rove api land --task-id a              # merge the winning branch
```

## Let your agent drive

Install the companion skill so your coding agent can run this loop itself:

```bash
rove skill install
```

## If something's wrong

```bash
rove doctor            # check daemon, engines, git
rove doctor --report   # write a bundle for a bug report
```

More fixes in [Troubleshooting](TROUBLESHOOTING.md).

## Next steps

- [Concepts](CONCEPTS.md) — tasks, sessions, and what survives what.
- [The TUI](TUI.md) — status glyphs, the Inbox, diff review, and the pages.
- [CLI reference](CLI.md) — every `rove` command.
- [rove api](API.md) — the scriptable surface for scripts and agents.
- [Configuration](CONFIGURATION.md) — engines, themes, notifications.
