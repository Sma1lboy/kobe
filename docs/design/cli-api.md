# CLI API — one bin, scriptable, skill-driven

> Design doc. Not implemented yet. Captures the decision shape so a
> future agent (human or otherwise) picks up implementation with full
> context.
>
> Sibling of `bridge.md` (superseded by ADR-0003; doc now in git history): that doc covers the MCP-bridge
> surface (long-lived stdio child of `claude`); this doc covers a
> short-lived CLI surface that the model drives from its `Bash` tool.
> MCP bridge stays in tree as a fallback; CLI becomes the recommended
> path.
>
> Linear epic: TBD (file before P1 work starts).

---

## 1. Why CLI, not MCP

The MCP bridge works but has three structural problems that show up in
practice:

1. **Lifecycle entanglement.** The bridge subprocess is a child of
   `claude`, not kobe. When the orchestrator SIGKILLs a wedged session,
   the bridge sometimes survives as a PPID=1 zombie. We added a
   PPID-watcher (`src/cli/mcp-bridge.ts:279-283`) after observing ~55
   accumulated zombies in a single day of dev. This is a permanent
   tax on a long-lived design.

2. **Connection state.** The bridge holds an open Unix socket to kobe
   for the full duration of the `claude` session. Any daemon
   restart, `kobed restart`, or socket drop yanks the rug out from
   under an in-flight tool call. Reconnection logic is non-trivial and
   the failure mode (silent "tool unavailable") is hostile to users.

3. **Discoverability + portability.** MCP only helps inside Claude
   Code. The user runs kobe under Codex too, and may run it under
   Cursor / OpenClaw / Hermes / a custom agent. Every one of these
   shells out to `bash` happily; not every one of them speaks MCP, and
   none of them speak it the same way.

A `kobe api <verb>` subcommand sidesteps all three. Each call is one
short-lived process: open socket → one RPC → print JSON → exit. No
zombie surface, no reconnect logic, and any agent that has a `Bash`
tool can use it. Failure mode is a non-zero exit code with a JSON
error on stderr — exactly what shell scripting already knows how to
handle.

---

## 2. Goal

Three deliverables:

1. **One `kobe` binary.** `kobed` collapses into `kobe daemon ...`.
   The `kobed` shim either stays for one minor release as an alias, or
   gets dropped now — see §6.
2. **`kobe api <verb>` subcommand surface.** Five verbs, mapped 1:1 to
   existing daemon protocol methods. Stdout = newline-terminated JSON.
3. **Bundled skill + README path.** `kobe skill install` writes a
   SKILL.md that teaches the model when and how to use these verbs.
   README documents the install.

Non-goals (deliberately):

- Removing the MCP bridge code. It stays in tree for installs that
  already use it. We just stop recommending it.
- Auth / token / network exposure on the daemon socket. Same posture
  as today — local Unix-socket only.
- A "remote kobe" mode. Single-host scope.

---

## 3. The `kobe api` surface

Five verbs. Each takes flag-style args (`--task-id ID`, not positional)
so the skill examples stay readable and tab IDs / paths with spaces
don't trip parsers.

| verb | flags | daemon method | returns |
|---|---|---|---|
| `kobe api spawn-task` | `--repo PATH --prompt TEXT [--title T] [--base-branch B]` | `task.spawn` | task JSON (id, branch, worktree, status) |
| `kobe api create-tab` | `--task-id ID [--title T]` | `chat.tab.create` | tab JSON (id, title) |
| `kobe api send` | `--task-id ID --prompt TEXT [--tab-id TID]` | `chat.send` | `{ ok: true }` |
| `kobe api get-task` | `--task-id ID` | reads `task.list` snapshot, filters | task JSON |
| `kobe api get-tab` | `--task-id ID --tab-id TID` | reads task snapshot | tab JSON (incl. last N messages) |

### Output contract

- **Default**: one JSON object per call, written to stdout, terminated
  by `\n`. Exit code 0.
- **Errors**: JSON object `{ "error": { "message": "...", "code": "..." } }`
  to **stderr**, exit code non-zero. Never mixed with stdout — that
  way `kobe api list-tasks | jq '.[].id'` doesn't choke on error
  text. (No `list-tasks` in the v1 surface, but the principle stands
  if/when we add it.)
- **`--pretty`** flag: pretty-print stdout JSON for human inspection.
  Off by default — machines first, humans second.
- **No stdin RPC.** Every verb takes its full payload in argv. Avoids
  the "did the agent forget to close stdin" failure mode.

### What's deliberately NOT in v1

- `list-tasks`: the agent rarely needs to enumerate; it already has
  task IDs from prior calls. Add when a real use case shows up.
- `wait` / blocking poll: the skill teaches `sleep + get-task` loops
  rather than us implementing a server-side wait. Simpler to debug,
  fewer wedge modes.
- `archive` / `delete`: hard rule says no deletion from automation.
  Keep destructive ops in the TUI.
- `interrupt`, `steer`, `permission-mode`, `model` changes: power-user
  TUI flows. Not the agent's job.

### Why these five and not the full daemon protocol

The daemon protocol has ~25 request types (`packages/kobe-daemon/src/daemon/protocol.ts`).
Most are TUI-driven (focus changes, draft updates, plan-usage polling).
The five above are the minimum complete set for *fan-out + report
back*, which is the only agent workflow we want to optimize for in v1.
Anything else, the agent can do inside its own chat — it doesn't need
to drive kobe.

---

## 4. Daemon requirement + auto-start

`kobe api` requires a running daemon. Two options:

**Option A — hard requirement.** If `~/.kobe/run/daemon.sock` is
absent, print `kobe api: no daemon (run \`kobe daemon start\`)` to
stderr, exit 2. The agent surfaces this to the user.

**Option B — auto-start on demand.** If the socket is absent, spawn a
daemon (same path as `connectOrStartDaemon` already takes in
`bin/kobed.ts`), wait for ready, then run the RPC.

Recommendation: **A**, with a single nudge: when the user runs `kobe`
for the first time and starts the TUI, the TUI's daemon is already
running. The only path where this matters is "user installed kobe but
hasn't launched the TUI yet, and the agent tries to spawn a task" —
rare, and "tell me to run a thing" is a fine error for that case.

Open for §8.

---

## 5. Skill — content + distribution

The CLI alone doesn't make the agent *use* kobe. The skill does.

### Content sketch (target ~60 lines)

```
# kobe — parallel coding tasks from your shell

When the user asks you to "try N approaches in parallel", "fan out",
"compare implementations side-by-side", or to split exploration into
subtasks: prefer spawning kobe tasks over doing N attempts
sequentially in one chat.

## How
- Spawn each subtask: `kobe api spawn-task --repo $PWD --prompt "..."`
  Returns JSON with `id`, `worktree_path`, `branch`. Read `id`.
- Cap fan-out at 3-4 in parallel. Each gets its own scoped prompt
  (don't dump the full conversation).
- Poll status: `sleep 5; kobe api get-task --task-id <id>` until
  `status` is `idle` or `awaiting-approval`. Don't tight-loop.
- Read results: `kobe api get-tab --task-id <id> --tab-id <tab>`.
- Tell the user what was spawned, with IDs, so the sidebar reads back
  correctly.

## Don't
- Single simple tasks → just do it in your own chat. No spawn.
- Recursive spawn from inside a spawned task. There is no recursion
  guard yet; you'll starve the concurrency cap.
- Use `kobe api send` as a chat channel — every message is a full
  agent turn, expensive.
```

This is roughly the same content as the MCP-targeted skill notes in
`bridge.md` §4, retargeted to Bash invocation.

### Distribution

Same options as `bridge.md` §4 but for a SKILL.md file:

- **A — auto-write** on first `kobe` launch. Zero steps, but pollutes
  `~/.claude/skills/` without consent.
- **B — `kobe skill install`** subcommand. User runs once; subcommand
  writes to `~/.claude/skills/kobe/SKILL.md`, diff-prompt if exists.
- **C — first-launch onboarding banner** in the TUI.

Recommended: **B**, same as in `bridge.md`. Project-level overrides
(`<repo>/.claude/skills/kobe/SKILL.md`) come for free. `kobe diagnose`
reports `skill: not installed` so the user has a discoverable hint.

A `kobe skill uninstall` mirror is cheap and worth adding.

---

## 6. The kobed → `kobe daemon` merge

This is the prerequisite the user called out before any of the API
work lands.

### Current state

- `packages/kobe/package.json` declares two bins:
  - `kobe` → `dist/cli/index.js`
  - `kobed` → `dist/bin/kobed.js`
- `kobed start|stop|status|restart` is the only surface. ~130 lines.

### Proposal

Move every `kobed` subcommand under `kobe daemon`:

| was | becomes |
|---|---|
| `kobed start` | `kobe daemon start` |
| `kobed stop` | `kobe daemon stop` |
| `kobed status` | `kobe daemon status` |
| `kobed restart` | `kobe daemon restart` |

Implementation: `packages/kobe/src/cli/daemon-cmd.ts` exports
`runDaemonSubcommand(argv)`; `src/cli/index.ts` routes `kobe daemon
...` to it. The body is mostly a copy-paste from
`src/bin/kobed.ts` — same `KobeDaemonClient`, same socket/pid paths.

### Back-compat — hard cut (locked)

`kobed` gets removed from `package.json` bin in the same release that
introduces `kobe daemon ...`. CHANGELOG entry calls out the rename so
any user with `kobed restart` in a script breaks loudly the first
time, not silently. We're pre-1.0; semver permits it, and the
discoverability of `kobe daemon ...` (visible in `kobe --help`) more
than pays back the one-time muscle-memory disruption.

No shim, no alias. Two-surface tax avoided.

### What changes inside the codebase

- `src/bin/kobed.ts` becomes a thin re-export (or deletes entirely if
  hard-cut wins).
- All docs grep-replace `kobed` → `kobe daemon`. Search hits:
  `AGENTS.md`, `HANDOFF.md`, `docs/design/daemon.md`, `docs/design/bridge.md`,
  scripts under `packages/kobe/scripts/`.
- `bun run` scripts that reference `kobed` get updated.

---

## 7. README rewrite

Three new sections in `packages/kobe/README.md`, ordered for a new
reader:

1. **"Using kobe from another agent"** — short rationale, the
   `kobe api` verb table, one example shell session.
2. **"Install the skill"** — `kobe skill install`, what file it
   writes, how to uninstall, mention of project-level overrides.
3. **"From Bash"** — the canonical example: spawn one parallel task,
   poll for completion, read the result.

The existing TUI sections stay first — kobe is a TUI product; the API
is for *its own* spawned agents.

---

## 8. Open decisions

| # | question | options | status |
|---|---|---|---|
| 1 | `kobed` back-compat | hard cut / one-release shim / indefinite alias | **decided: hard cut** (see §6) |
| 2 | verb shape | `kobe api spawn-task` / `kobe task spawn` | recommended: `kobe api spawn-task` |
| 3 | output default | JSON / pretty | recommended: JSON, `--pretty` for humans |
| 4 | daemon missing | hard error / auto-start | recommended: hard error |
| 5 | skill install | command / first-launch / banner | recommended: `kobe skill install` |
| 6 | drop MCP bridge | now / later / keep forever | recommended: keep forever as fallback |
| 7 | rename TUI launch | `kobe` (today) / `kobe tui` (explicit) | recommended: `kobe` stays |

Items 2-7 lock during P2 implementation unless contested.

---

## 9. Phasing

Each phase is one PR, green on its own, mergeable independently.

| phase | PR scope | gate |
|---|---|---|
| **P1** | Merge `kobed` → `kobe daemon ...`. Resolve §8.1. | `kobe daemon status` works; old `kobed` either errors with rename hint or aliases. |
| **P2** | `kobe api <verb>` subcommands wired to `KobeDaemonClient`. All 5 verbs from §3. | Smoke test: spawn a task from `bash`, observe sidebar update. |
| **P3** | `kobe skill install` + bundled SKILL.md under `packages/kobe/share/skills/kobe/`. | Install on a fresh `~/.claude` and read back the file. |
| **P4** | README rewrite + AGENTS.md / HANDOFF.md / bridge.md cross-links updated. | Manual: a new user can install + spawn a task in <5 min. |

Total estimate: 4 small PRs, ~150-300 LOC each excluding generated docs.

---

## 10. Implementation plan

Concrete enough that any agent picks up a phase and starts typing.
Phases are independent PRs (per §9); each is green on its own. The
P-numbering mirrors §9.

### P1 — `kobed` → `kobe daemon ...` (hard cut)

**Files added**

- `packages/kobe/src/cli/daemon-cmd.ts` — NEW. Owns the four
  subcommands. Body is a near-direct port of `src/bin/kobed.ts:9-128`
  with one signature change (no `argv[2]` shift; the dispatcher
  passes `rest` already trimmed of `daemon`).

  ```ts
  export async function runDaemonSubcommand(argv: readonly string[]): Promise<void> {
    const [command = "status"] = argv
    const socketPath = defaultDaemonSocketPath()
    const pidPath = defaultDaemonPidPath()
    // ...same switch on command as src/bin/kobed.ts
  }
  ```

**Files modified**

- `packages/kobe/src/cli/index.ts` — add one branch in `main()`,
  next to the existing `mcp-bridge` route:
  ```ts
  if (subcommand === "daemon") {
    const { runDaemonSubcommand } = await import("./daemon-cmd.ts")
    await runDaemonSubcommand(rest)
    return
  }
  ```
- `packages/kobe/scripts/build.ts` — drop `./src/bin/kobed.ts` from
  `entrypoints`, drop `./dist/bin/kobed.js` from `OUT_FILES`. Update
  the JSDoc that mentions `kobed` bin output.
- `packages/kobe/scripts/compile.ts` — verify nothing else references
  the kobed entry; remove if it does.
- `packages/kobe/package.json` — delete `"kobed": "dist/bin/kobed.js"`
  line from `bin`.

**Files deleted**

- `packages/kobe/src/bin/kobed.ts` — full delete. (Hard rule: user
  explicitly authorized this delete via the §8.1 decision.)
- `packages/kobe/src/bin/` directory — empty after the above; remove.

**Doc grep-replace (P1 part)**

- `AGENTS.md`, `HANDOFF.md`: `kobed start` → `kobe daemon start`, etc.
- `docs/design/daemon.md`, `docs/design/bridge.md`: same.
- `packages/kobe/README.md`: same.
- `packages/kobe/CHANGELOG.md`: new entry for the next version with
  the rename callout (single line — users hit it once on upgrade,
  this is their warning).

**Test surface**

- `test/daemon/*` — most tests spawn the daemon via
  `connectOrStartDaemon`, not via the `kobed` bin, so behavior is
  unchanged. Grep for `"kobed"` to catch any string-literal tests and
  retarget to `kobe daemon`.

**Gate**

```
bun run typecheck && bun run test:fast && bun run test:socket
kobe daemon start   # spawns daemon
kobe daemon status  # JSON dump
kobe daemon stop
```

### P2 — `kobe api <verb>`

**Files added**

- `packages/kobe/src/cli/api-cmd.ts` — NEW. Single file dispatcher;
  five verbs are small enough to live in-file under ~250 LOC.

  Shape:

  ```ts
  import { KobeDaemonClient } from "../client/index.ts"
  import { defaultDaemonSocketPath } from "../daemon/paths.ts"

  type Flags = ReadonlyMap<string, string>

  export async function runApiSubcommand(argv: readonly string[]): Promise<void> {
    const [verb, ...rest] = argv
    const { flags, pretty } = parseFlags(rest)
    const client = new KobeDaemonClient(defaultDaemonSocketPath())
    try {
      await connectOrFail(client)
      switch (verb) {
        case "spawn-task":  return emit(await spawnTask(client, flags), pretty)
        case "create-tab":  return emit(await createTab(client, flags), pretty)
        case "send":        return emit(await send(client, flags), pretty)
        case "get-task":    return emit(await getTask(client, flags), pretty)
        case "get-tab":     return emit(await getTab(client, flags), pretty)
        default: fail(`unknown verb: ${verb}`, "BAD_VERB")
      }
    } finally {
      client.close()
    }
  }
  ```

  Per-verb bodies are straight pass-through to `client.request(...)`:

  ```ts
  async function spawnTask(c: KobeDaemonClient, f: Flags) {
    return c.request("task.spawn", {
      repo: required(f, "repo"),
      prompt: required(f, "prompt"),
      title: f.get("title"),
      baseRef: f.get("base-branch"),
    })
  }
  ```

  `connectOrFail` distinguishes `ENOENT` (daemon not running) from
  other errors and emits the recommended `BAD_DAEMON` error verbatim
  per §4.

**`get-task` / `get-tab` decision (see §3)**

Option A — add `task.get` to the daemon protocol so `get-task` is a
single round-trip. ~15 LOC in `daemon/protocol.ts` + `daemon/server.ts`.

Option B — fetch `task.list`, filter for the id client-side. Zero
protocol change, one extra serialization round.

Recommended: **A**. The protocol already has `task.archive`,
`task.rename`, etc. — a `task.get` belongs in the set. The bridge
RPC already exposes `get_task` directly off the orchestrator, so the
behavior is exactly what we want.

`get-tab` builds on the result of `task.get` (tabs are inline on the
serialized task) and combines it with `chat.history` for the actual
messages.

**Files modified**

- `packages/kobe/src/cli/index.ts` — one new branch:
  ```ts
  if (subcommand === "api") {
    const { runApiSubcommand } = await import("./api-cmd.ts")
    await runApiSubcommand(rest)
    return
  }
  ```
- `packages/kobe-daemon/src/daemon/protocol.ts` — add `task.get` to
  `DaemonRequestName`.
- `packages/kobe-daemon/src/daemon/server.ts` — handle the new case (one
  `orch.getTask(taskId)` call).

**Test surface**

- `test/cli/api-cmd.test.ts` — NEW. Spin up a daemon against a tmp
  `KOBE_HOME_DIR`, exec `bun src/cli/index.ts api spawn-task --repo ...`,
  parse stdout JSON, verify expected fields. Repeat for each verb.

**Gate**

End-to-end smoke from Bash:

```
kobe daemon start
TASK=$(kobe api spawn-task --repo $PWD --prompt "say hi" | jq -r .taskId)
kobe api get-task --task-id $TASK | jq .status
kobe api create-tab --task-id $TASK --title "exploration"
kobe api send --task-id $TASK --prompt "any update?"
kobe daemon stop
```

### P3 — `kobe skill install`

**Files added**

- `packages/kobe/share/skills/kobe/SKILL.md` — NEW. ~60-line skill
  content from §5.
- `packages/kobe/src/cli/skill-cmd.ts` — NEW. Two commands:
  `install`, `uninstall`.

  Install logic:
  1. Resolve bundled SKILL.md path. In dev: `import.meta.url`-relative
     `../../share/skills/kobe/SKILL.md`. In production npm install:
     `dist`-relative — needs `scripts/build.ts` to copy `share/` into
     `dist/share/` so the file is reachable post-bundle.
  2. Target path: `${process.env.HOME}/.claude/skills/kobe/SKILL.md`.
  3. If target exists with identical content → print "already
     installed" + path; exit 0.
  4. If target exists with different content → print diff (or just a
     "differs" warning + show byte counts), prompt
     `overwrite / skip / cancel`. `--yes` skips prompt for scripts.
  5. Else → `mkdir -p` + write + chmod 0644. Print the path.

  Uninstall: best-effort `rm` of the file (NOT the directory; user
  may have other kobe-related skill files). Print what was removed.

**Files modified**

- `packages/kobe/src/cli/index.ts` — route `skill` subcommand.
- `packages/kobe/scripts/build.ts` — copy `share/` → `dist/share/`
  post-`Bun.build`. ~5 LOC `cp -r` equivalent.
- `packages/kobe/package.json` `files` — add `share` so npm includes
  it in the published tarball. (Or rely on the `dist/share/` path
  alone; depends on whether SKILL.md is shipped raw or only as dist
  copy. Recommend `dist/share/` only — single source of truth.)
- `packages/kobe/src/cli/diagnose.ts` — add a `skill: installed | not installed`
  line that reads `~/.claude/skills/kobe/SKILL.md`.

**Gate**

```
kobe skill install        # writes ~/.claude/skills/kobe/SKILL.md
kobe diagnose | grep skill
kobe skill install        # idempotent
kobe skill uninstall
```

### P4 — README + cross-doc

**Files modified**

- `packages/kobe/README.md` — add three sections after the existing
  TUI overview:
  - **"Using kobe from another agent"**: rationale + the §3 verb table
    + one example shell session (the §11 P2 gate block, lightly
    edited for readability).
  - **"Install the skill"**: `kobe skill install` + what it writes +
    project-level override path (`<repo>/.claude/skills/kobe/SKILL.md`).
  - **"Daemon"**: `kobe daemon start / stop / status / restart`
    (replaces any existing `kobed` mention).
- `docs/design/bridge.md` — add a top-of-doc note: "the CLI API in
  `cli-api.md` is now the recommended path; this MCP bridge stays as
  a fallback for installs that already use it." No content removed —
  the doc still documents the live MCP code.
- `AGENTS.md`, `HANDOFF.md` — already grep-replaced in P1; verify the
  README rewrite didn't leave dangling references.
- `packages/kobe/CHANGELOG.md` — final entry per release covering all
  four phases (`kobed` rename + new `kobe api` + skill installer +
  docs).

**Gate**

Manual: new user reads README, runs `kobe daemon start`,
`kobe skill install`, then asks Claude to "spawn 3 parallel tasks to
implement X three different ways" and the model uses
`kobe api spawn-task` without further prompting.

---

## 11. References

- `packages/kobe/src/cli/index.ts` — current subcommand router (`add`,
  `diagnose`, `update`, `theme`, `mcp-bridge`).
- `packages/kobe/src/bin/kobed.ts` — what gets merged into `kobe daemon ...`.
- `packages/kobe/src/cli/mcp-bridge.ts` — MCP path that stays as
  fallback.
- `packages/kobe-daemon/src/daemon/protocol.ts` — full daemon RPC surface;
  the five `kobe api` verbs are a strict subset.
- `packages/kobe-daemon/src/client/index.ts` — `KobeDaemonClient`, the
  ready-made transport every `kobe api` verb will use.
- [`bridge.md`](./bridge.md) — sibling design doc for the MCP-bridge
  path; this file supersedes its skill-distribution discussion (§4)
  but keeps the MCP bridge itself in tree as a fallback.
