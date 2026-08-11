# Engines

An **engine** is the AI coding CLI a task runs on — `claude`, `codex`,
`copilot`, `kimi`, or one you register yourself. kobe runs the real
interactive CLI inside the task's terminal session.

```text
Task = git worktree + engine session + branch
```

## Which engines are supported

| Engine | Id | Account detect | Activity badge | History | Model picker |
|---|---|---|---|---|---|
| Claude Code | `claude` | ✓ | ✓ | ✓ | ✓ |
| Codex | `codex` | ✓ | ✓ (after you trust hooks) | ✓ | ✓ + effort levels |
| GitHub Copilot | `copilot` | ✓ | partial | ✓ | — |
| Kimi Code | `kimi` | ✓ | — | — | — |
| Anything you register | custom | — | — | — | — |

**Claude Code is the default** and the most complete: its quota probe drives
rate-limit auto-resume and the Settings usage dashboard.

**Kimi is partial.** kobe finds the binary and reads its login state, so it
launches and shows your account. But its session format is unverified, so
there's no history reader — auto-title keeps the placeholder and
`kobe api read-output` reports `engine_unsupported` rather than guessing.

## Picking an engine

Per task, at creation time, or with `v` in the sidebar. The default for new
tasks comes from Settings → Engines (`defaultVendor`), and kobe remembers the
last engine you used per project.

Engines whose CLI isn't installed are hidden from the new-task dialog. Custom
engines always show — you added it, so kobe assumes you meant it.

### Reasoning effort

Codex accepts `none`, `low`, `medium`, `high`, `xhigh`, passed as
`-c model_reasoning_effort=<level>`. Other engines have no effort flag kobe
can drive; a selected effort is ignored there rather than passed through.

### Custom launch commands

Override any engine's launch command in Settings → Engines, or by hand in
`state.json`:

```json
{ "engineCommand.claude": "claude --model opus" }
```

Quotes are honored, so `claude --append-system-prompt "be terse"` works. For
Claude, kobe appends its own `--session-id` so the tab stays resumable — but
if your override already pins the conversation (`--session-id`, `--resume`,
`--continue`, `--from-pr`), kobe leaves it alone.

If an engine exits non-zero, the terminal stays open with a banner pointing
at Settings → Engines, and drops you into a shell.

## Activity badges

The sidebar shows what each session is doing: **working**, **done**, or
**needs input**. There's nothing to configure — kobe reads the engine's own
hook events, falling back to its transcript when hooks aren't available.

One thing worth knowing: **only claude and codex can show "needs input"**.
Distinguishing "waiting on a permission prompt" from "thinking" requires a
hook; the other engines top out at working/done. kobe labels the gap honestly
rather than guessing.

Codex won't run kobe's hooks until you trust them once via `/hooks`, so Codex
badges stay dark until you approve. That's by design — kobe writes the hook
definition but never bypasses the trust prompt for you.

Mechanics: [design/engine-internals.md](./design/engine-internals.md).

## Resuming and forking

**Resume.** A Claude tab whose process is gone (reboot, unarchive) relaunches
into the same conversation instead of a blank one. A tab that never sent a
first message isn't resumed — there's no transcript yet. Codex, Copilot,
Kimi, and custom engines can't take a caller-set session id, so their tabs
relaunch fresh.

`ctrl+a` `y` opens the resume picker for the active task.

**Fork.** `ctrl+a` `c` opens a new tab in the *same* worktree, starting from
the active tab's conversation and diverging from there. Pick the engine, and
one of two things happens:

*Same engine* → a native fork. The CLI branches its own conversation, so both
sides keep full context:

| Engine | Fork? | How |
|---|---|---|
| `claude` | ✓ | `--resume <src> --fork-session` |
| `codex` | ✓ | `codex fork <src>` |
| `copilot` | — | `--resume` reopens the same session, it doesn't branch |
| `kimi` | — | same limitation |
| custom | — | kobe doesn't know their flags or session store |

*Different engine* → a handoff. This is the move that saves you when you hit
a usage limit mid-task. The new engine starts fresh with a first prompt that
points it at the old session's transcript and asks it to state where the
previous one stopped — that sentence is how you check the handoff landed.

Handoffs work claude ⇄ codex in both directions. A handoff *from* Copilot,
Kimi, or a custom engine is refused with a reason (kobe can't name their
transcript); a handoff *to* them works fine.

## Custom engines

Any CLI can be an engine. **Settings → Engines → + Add engine** asks for an
id, a launch command, and an optional display name. Or by hand:

```json
{
  "customEngineIds": ["aider"],
  "engineCommand.aider": "aider --model sonnet",
  "engineName.aider": "Aider"
}
```

Being in `customEngineIds` *is* the registration.

**What you get:** a real hosted session with the full keep-alive and per-repo
init treatment. **What you don't:** no history reader, no account detection,
no activity badge, no session resume. kobe launches your CLI and stays out of
the way rather than pretending to understand its internals.

Press `x` on an engine row in Settings to reset a built-in's overrides, or
remove a custom engine entirely.

## Where conversations are stored

Engines own their own history. kobe reads it, never writes it.

| Engine | Transcripts |
|---|---|
| `claude` | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` |
| `codex` | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` |
| `copilot` | `~/.copilot/session-state/<id>/` |

That's why a crash never loses a conversation, and why history survives
`kobe reset` and a machine reboot.
