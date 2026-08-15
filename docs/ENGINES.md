# Engines

An **engine** is the AI coding CLI a task runs on — `claude`, `codex`,
`copilot`, `kimi`, or one you register yourself. Rove runs the real
interactive CLI inside the task's terminal session.

```text
Managed task = one git worktree + one branch + one or more terminal tabs
```

A Task can own several terminal tabs. Each engine tab has its own PTY process
and conversation, but opening another engine or shell tab does **not** create
another worktree: ordinary sibling tabs use the same Task directory. Two agents in
sibling tabs can therefore edit each other's work; create another task when
you need git-level isolation and a separate branch.

## Which engines are supported

| Engine | Id | Account detect | Activity badge | History | Model picker |
|---|---|---|---|---|---|
| Claude Code | `claude` | ✓ | ✓ | ✓ | ✓ |
| Codex | `codex` | ✓ | ✓ (after you trust hooks) | ✓ | ✓ + effort levels |
| GitHub Copilot | `copilot` | ✓ | partial | ✓ | — |
| Kimi Code | `kimi` | ✓ | ✓ | handoff only | — |
| Anything you register | custom | — | — | — | — |

**Claude Code is the default** and the most complete: its quota probe drives
rate-limit auto-resume and the Settings usage dashboard.

**Kimi is partial.** Rove finds the binary, reads its login state, and can
locate each session's transcript — enough to watch it for activity and to
hand the conversation to another engine. It still doesn't *parse* that
transcript (the wire format is unverified), so auto-title keeps the
placeholder and `rove api read-output` reports `engine_unsupported` rather
than guessing.

## Picking an engine

Per task, at creation time, or with `v` in the sidebar. The default for new
tasks comes from Settings → Engines (`defaultVendor`), and Rove remembers the
last engine you used per project.

Engines whose CLI isn't installed are hidden from the new-task dialog. Custom
engines always show — you added it, so Rove assumes you meant it.

### Reasoning effort

Codex accepts `none`, `low`, `medium`, `high`, `xhigh`, passed as
`-c model_reasoning_effort=<level>`. Other engines have no effort flag Rove
can drive; a selected effort is ignored there rather than passed through.

### Workspace trust

Claude, Codex, and Kimi each gate a first launch in a never-seen directory
behind a trust dialog — and every task worktree is such a directory, so a
hosted session can't answer it (Kimi's dialog even exits the process when a
pasted first message lands on "Don't trust"). Before spawning an engine into
a Rove-created worktree, Rove writes the vendor's own trust record for that
path — `~/.claude.json` `projects[<path>].hasTrustDialogAccepted`,
`~/.codex/config.toml` `[projects."<path>"] trust_level = "trusted"`, or
`~/.kimi-code/workspace-trust/` — merging into existing entries, never
clobbering. This only ever fires for worktrees Rove itself created from a
repo you already work in; your own directories are untouched.

### Custom launch commands

Override any engine's launch command in Settings → Engines, or by hand in
`state.json`:

```json
{ "engineCommand.claude": "claude --model opus" }
```

Quotes are honored, so `claude --append-system-prompt "be terse"` works. For
Claude, Rove appends its own `--session-id` so the tab stays resumable — but
if your override already pins the conversation (`--session-id`, `--resume`,
`--continue`, `--from-pr`), Rove leaves it alone.

If an engine exits non-zero, the terminal stays open with a banner pointing
at Settings → Engines, and drops you into a shell.

## Activity badges

The sidebar shows what each session is doing: **working**, **done**, or
**needs input**. There's nothing to configure — Rove reads the engine's own
hook events, falling back to its transcript when hooks aren't available.

One thing worth knowing: **only claude and codex can show "needs input"**.
Distinguishing "waiting on a permission prompt" from "thinking" requires a
hook; the other engines top out at working/done. Rove labels the gap honestly
rather than guessing.

Codex won't run Rove's hooks until you trust them once via `/hooks`, so Codex
badges stay dark until you approve. That's by design — Rove writes the hook
definition but never bypasses the trust prompt for you.

Mechanics: [design/engine-internals.md](./design/engine-internals.md).

## Resuming and forking

**Resume.** A Claude tab whose process is gone (reboot, unarchive) relaunches
into the same conversation instead of a blank one. A tab that never sent a
first message isn't resumed — there's no transcript yet. Codex, Copilot,
Kimi, and custom engines can't take a caller-set session id, so their tabs
relaunch fresh.

`ctrl+a` `y` opens the resume picker for the active task.

**Continue in a new tab.** `ctrl+a` `c` opens the continuation flow in the
*same* worktree. What happens depends on the source and destination engines:

*Same engine* → a native fork only when that CLI can actually branch a
conversation. The two resulting tabs keep the source context and then diverge:

| Engine | Native fork? | How |
|---|---|---|
| `claude` | ✓ | `--resume <src> --fork-session` |
| `codex` | ✓ | `codex fork <src>` |
| `copilot` | — | starts a fresh Copilot session with a transcript handoff |
| `kimi` | — | starts a fresh Kimi session with a transcript handoff |
| custom | — | refused; Rove doesn't know its session store |

Copilot's `--resume` and Kimi's `-S` reopen rather than branch, which would put
two live processes on one transcript. Rove therefore uses the same transcript
handoff as a cross-engine continuation: the new tab is a fresh conversation
that reads where the previous one stopped. A custom engine without a known
session store is refused instead of silently opening a blank continuation.

*Different built-in engine* → a handoff. This is the move that saves you when
you hit a usage limit mid-task. The new engine starts fresh with a first prompt
that points it at the old session's transcript and asks it to state where the
previous one stopped — that sentence is how you check the handoff landed.

Handoffs work in every direction between the four built-ins — the receiving
agent is handed the previous transcript's *path* and reads it in whatever
format it finds, so no format ever has to be converted. Only a **custom**
engine can't be a handoff source (Rove doesn't know its session store); that
case is refused with a reason. A handoff *to* a custom engine works fine.

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
no activity badge, no session resume. Rove launches your CLI and stays out of
the way rather than pretending to understand its internals.

Press `x` on an engine row in Settings to reset a built-in's overrides, or
remove a custom engine entirely.

## Where conversations are stored

Engines own their own history. Rove reads it, never writes it.

| Engine | Transcripts |
|---|---|
| `claude` | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` |
| `codex` | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` |
| `copilot` | `~/.copilot/session-state/<id>/events.jsonl` |
| `kimi` | `~/.kimi-code/sessions/<workspace>/<session>/agents/main/wire.jsonl` |

That's why a crash never loses a conversation, and why history survives
`rove reset` and a machine reboot.
