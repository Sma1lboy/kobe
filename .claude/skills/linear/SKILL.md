---
name: linear
description: Manage issues, projects, labels, cycles in Linear via the schpet/linear-cli (`linear` binary). Use when the user wants to read, create, update, or comment on Linear tickets. Do NOT use the Linear MCP server — this skill is the replacement.
metadata:
  short-description: Manage Linear via the linear CLI
  internal: true
---

# Linear (CLI-based)

This skill drives Linear through the [`schpet/linear-cli`](https://github.com/schpet/linear-cli) binary (`linear`), not via MCP. The MCP-based version was removed — this is the only path.

## Why CLI, not MCP

- The MCP setup needs `codex mcp add linear` + OAuth flow + restart. We're on Claude Code, not codex, and the MCP path was flaky for Jackson.
- `linear` CLI is `brew`-installed, authenticated once via system keyring, and scriptable from `Bash`. No tool-loading dance.

## Prerequisites — verify before first use

```bash
which linear              # /opt/homebrew/bin/linear
linear auth whoami        # Workspace + user; non-zero if not logged in
linear auth list          # Default workspace marked with *
```

If `whoami` fails, surface to the user — they'll run `linear auth login` themselves (browser OAuth).

## Default context for kobe

When working in `/Users/jacksonc/i/kobe`, defaults are:

- **Workspace:** `codesfox`
- **Team:** `KOB` (key) / `Kobe` (name) — pass with `--team KOB`
- **Active project:** `0.6 tmux 版本` — pass with `--project "0.6 tmux 版本"`
- **Legacy project:** `0.5 opentui 版本` — shipped/stale self-rendered opentui chat work; do not file new v0.6 tmux work there.
- **Workspace labels:** `Bug`, `Chore`, `Doc`, `Feature`, `Featurebase`, `Tech Debt`

Re-fetch with `linear team list` / `linear project list` / `linear label list` if the user mentions something new.

## Required workflow

1. **Clarify scope.** Confirm team/project/labels/priority before writing. For kobe issues, default to team `KOB` + project `0.6 tmux 版本` unless the user says otherwise.
2. **Read first.** `linear issue list`, `linear issue view <id>`, `linear project list` to build context — don't create blind.
3. **Write with `--no-interactive`.** All `create` / `update` calls in this skill MUST pass `--no-interactive` so they don't hang waiting for prompts.
4. **Long descriptions go through a temp file.** Use `--description-file /tmp/<slug>.md` instead of `-d "..."` whenever the body has newlines or markdown — preserves formatting and avoids shell-quoting hell.
5. **Report the URL.** `linear issue create` prints the issue URL on success — surface it so the user can click through.

## Common commands

### Create an issue

```bash
cat > /tmp/issue-body.md <<'EOF'
<markdown body — context, scope, open questions>
EOF

linear issue create \
  --team KOB \
  --project "0.6 tmux 版本" \
  --title "<short imperative title>" \
  --description-file /tmp/issue-body.md \
  --label "Feature" \
  --no-interactive
```

Useful flags: `-p 1..4` (priority, 1=urgent), `-a self` (assign to me), `--estimate N`, `--cycle active`, `--milestone <name>`, `--parent <KOB-N>`, `--start` (move to In Progress immediately).

### Read

```bash
linear issue list                       # mine, default team
linear issue list --team KOB            # all my issues in KOB
linear issue view KOB-10                # full detail
linear issue query --help               # structured filters (state, label, assignee, …)
```

### Update / comment / state changes

```bash
linear issue update KOB-10 --state "In Progress"
linear issue update KOB-10 --label Bug
linear issue update KOB-10 --state Done       # mark complete on landing
linear issue comment add KOB-10 --body-file /tmp/note.md
linear issue start KOB-10                      # shortcut: move to In Progress
```

`--no-interactive` is a **create-only** flag — `update` and `comment add` don't accept it (and don't need it; they don't prompt). `comment add` uses `--body` / `--body-file`, not `-m`.

### Discovery

```bash
linear team list
linear project list
linear label list
linear issue query --help               # see all filter knobs
linear api '<GraphQL>'                  # raw escape hatch for anything CLI doesn't cover
```

## Hard rules

- **Never run `linear issue delete` / `linear team delete` / `linear project delete` without explicit user consent in the same turn.** Same rule as the workspace-level CLAUDE.md — destructive ops require the literal word "delete" or "remove" from the user.
- **Don't change default workspace** (`linear auth default`) without asking. Jackson works in multiple Linear workspaces; flipping the default has side-effects beyond this session.
- **Don't reach for the Linear MCP.** It's not installed and we don't want it back. If the CLI is missing or broken, surface to the user — don't try to fall back to MCP.
- **`--no-interactive` on every write.** The CLI will hang on stdin prompts otherwise; we have no TTY in tool calls.

## Troubleshooting

- `linear: command not found` → user needs `brew install schpet/tap/linear-cli` (or whatever the install path is for their setup).
- Auth errors → `linear auth whoami` to confirm; `linear auth login` to re-auth (interactive, user-driven).
- Wrong workspace → pass `--workspace codesfox` explicitly, or surface and ask which workspace the user means.
- "Team not found" → run `linear team list` and pass the team **key** (e.g. `KOB`), not the name.
- Long description got mangled → switched to `--description-file` instead of `-d`.
