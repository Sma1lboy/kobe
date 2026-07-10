# kobe — Context

Domain vocabulary for the TUI orchestrator. Every architectural conversation about kobe uses these terms verbatim; companion docs are [`docs/DESIGN.md`](./docs/DESIGN.md) (philosophy), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (file map), [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md) (chord boundaries), and [`docs/design/v2-tmux-handover.md`](./docs/design/v2-tmux-handover.md) (the v0.6 tmux-handover reshape).

> **v0.6 reshape (KOB-226).** kobe no longer drives `claude` as a stream-json subprocess and no longer renders its own chat. It became a **task launcher**: each **Task** gets a **tmux Session** that runs interactive `claude` natively, and "entering" a task is a **Handover** (attach the real TTY). Terms from the v0.5 chat era — **AI Engine Port**, **SessionPump**, **PendingInputBroker**, **ChatSessionController**, **Bridge** — are listed in the Retired section so old references resolve.

> **Pure-TUI pivot (2026-07, issue #16 — the embedded terminal).** `KOBE_TUI=1` boots the **Workspace Host**: a single-process React app (no tmux) whose center column is an in-process PTY running the task's real interactive engine CLI — kobe wraps the engine's own TUI instead of re-rendering its stream. **Both stacks are live today**: the tmux **Handover** is still the DEFAULT `kobe` launch path (`src/tui/index.tsx` gates on `nativeChatEnabled()`, `src/env.ts`), and the Workspace Host is the opt-in replacement direction. The Solid TUI was removed 2026-07-07 (0.7.73): React under `src/tui-react/**` is the only UI; framework-free cores stay under `src/tui/**`, including the observable state used by the Orchestrator and TUI Client. The briefly-explored AI-SDK native chat pane is **gone** (see Retired).

> **Outer monitor retired (2026-06; inventory/decision record `docs/design/app-retirement.md` lives in git history).** The transitional opentui shell (`app.tsx`) and its vocabulary — **Workspace** (capital W), **Live Preview**, **Cost Dashboard**, the `KOBE_NO_DAEMON` daemon-less mode — are **gone**. See the Retired section.

## Language

### Core nouns

**Task**:
One unit of work the user is tracking. Owns a single **Worktree**; in tmux mode it also owns one **tmux Session**, in the **Workspace Host** its engine sessions are **Terminal Tab**s. Persisted in `~/.kobe/tasks.json`.
_Avoid_: project, ticket, item, job.

**Worktree**:
The git worktree a **Task** is checked out into. 1:1 with **Task**. Allocated lazily — the directory only materialises on first enter (`Orchestrator.ensureWorktree`; both the **Handover** path and the Workspace Host's `activateTask` call it).
_Avoid_: workspace (overloaded), checkout, branch dir.

**Session**:
A persisted engine conversation on disk (Claude: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`). kobe reads these (engine history readers, auto-title, turn detection, restart-resume verification); it never writes them. Distinct from a **tmux Session** AND from a **PTY Host** session — qualify when more than one is in play.
_Avoid_: history (history is the contents OF a Session, not the Session itself).

### Handover model (tmux — today's default launch path)

Live code, not retired: plain `kobe` still lands here (`startDirectTmux`, `src/tui/direct.ts`), and `src/tui/panes/terminal/CLAUDE.md` marks this stack LIVE. The **Workspace Host** is the replacement direction; until the default flips, both vocabularies apply.

**tmux Session**:
The per-**Task** tmux session, named `kobe-<task-id>` on kobe's dedicated `-L kobe` socket (isolated from the user's own tmux). Holds one-or-more **ChatTab**s (tmux windows). Tagged with the **Task**'s id + **Worktree** via `@kobe_task` / `@kobe_worktree` session options so a new **ChatTab** can rebuild the same workspace. Persists across **Handover** detach AND a kobe restart. Built by `ensureSession` (`src/tui/panes/terminal/tmux.ts`).
_Avoid_: just "session" (collides with the engine **Session**), window, workspace.

**ChatTab**:
A tmux **window** inside a **Task**'s **tmux Session** — one independent engine conversation on the shared **Worktree**. Every ChatTab has the same four-pane layout: **Tasks pane** (left), engine CLI, **Ops pane** (upper right), shell (lower right). `Ctrl+T` opens a new ChatTab (`kobe new-chattab` → `newChatTab`, `src/tui/panes/terminal/chattab.ts`); the tmux status bar's window list is the tab switcher. The engine pane is tagged `@kobe_role=claude` so kobe can find it regardless of tmux's by-position pane numbering.
_Avoid_: tab (unqualified), window (use "tmux window" if you must name the mechanism), **Terminal Tab** (that's the Workspace Host's sibling concept).

**Handover**:
Entering a **Task** in tmux mode: `tmux attach` to the task's **tmux Session** with the real TTY, await exit. `kobe` attaches directly at launch (`startDirectTmux`, `src/tui/direct.ts`), and the **Tasks pane** `switch-client`s between tasks from inside; `Ctrl+Q` detaches back to the launching shell. The single applier is `enterTask` (`src/tui/lib/task-enter.ts`): ensure-or-heal the **tmux Session** → reconcile zen → mark active → fit + switch via `enterWindow` (`src/tui/panes/terminal/tmux.ts`), which welds the pre-switch fit to `switch-client` so no path lands on an unfitted (reflowing) window.
_Avoid_: enter, takeover, fullscreen (these describe the mechanics, not the concept).

**Ops pane**:
The `kobe ops` subprocess that fills a **ChatTab**'s upper-right pane — the React host is `src/tui-react/ops/host.tsx`, its framework-free logic `src/tui/ops/`. Re-hosts the FileTree (browse the **Worktree**) plus a slim file/diff viewer; Enter on a file injects `@<path>` into the engine pane via `tmux send-keys` (or opens a full-width preview window via `kobe ops --preview`). A separate OS process from the **TUI Client**, so it reads the outer app's theme via persisted UI prefs (read-only).
_Avoid_: files pane, sidebar.

**Tasks pane**:
The `kobe tasks` subprocess on the far left of a **ChatTab** (`src/tui-react/tasks-pane/host.tsx`) — the task list, rendered by the same `Sidebar` component the **Workspace Host** uses (`src/tui-react/panes/sidebar/`), so you can jump between **Task**s without detaching. Enter `tmux switch-client`s to another **Task**'s **tmux Session**. Read-only: the **Orchestrator** / **Daemon** own writes; this pane never mutates task state.
_Avoid_: sidebar (that's the component, not the pane), task list.

**tmux client**:
The shared low-level client for kobe's `-L kobe` server (`src/tmux/client.ts`): socket constant, spawn helpers with stderr logging, `tmuxSessionName` / `attachArgv`, session-option tagging, the claude-pane tag, and `base-index`-safe pane-id resolution. The single place that knows how to talk to the tmux server — the **Handover**, the **Ops pane**, and the **Tasks pane** all go through it.
_Avoid_: tmux wrapper, tmux utils.

**Session Layout**:
The pure command/layout builders for a **tmux Session** (`src/tmux/session-layout.ts`): pane percentages, shell-quoting, the keep-alive wrapper, the **Ops pane** command + its fallback. Pure (same inputs → same strings, no IO) so it's unit-tested. `ensureSession` is the imperative applier of this policy.
_Avoid_: pane plan, blueprint.

**Session Decision**:
The pure reuse/respawn policy for `ensureSession` (`src/tmux/session-decision.ts`): given the observed facts of an existing **tmux Session** (tags, engine-pane health, window count) and the target **Worktree**/vendor, returns `create | reuse | respawn-engine | rebuild` with a reason. Sibling policy module to **Session Layout**; `ensureSession` observes, decides, applies.
_Avoid_: session check, health check (those are inputs, not the policy).

### Pure-TUI workspace (`KOBE_TUI=1`)

**Workspace Host**:
The single-process React app `kobe` boots under `KOBE_TUI=1` (`startWorkspaceHost`, `src/tui-react/workspace/host.tsx`): Sidebar rail (fixed 32 cols) | **Terminal Tab** center | Files column, plus full-page swaps (Settings / Worktrees / Update) and zen mode (F6 or the ☯ chip) that hides the Files column. Holds daemon GUI lifetime (`role: "gui"`). On quit it `detachAll()`s the **PTY Registry**, so hosted engine sessions keep running for the next boot.
_Avoid_: outer monitor (the retired 2026-06 shell), native workspace/native chat (retired sense), app shell.

**Terminal Tab**:
One tab in the Workspace Host's center strip (`src/tui-react/workspace/TerminalTabs.tsx`; pure state core `src/tui/workspace/terminal-tabs-core.ts`) — an interactive engine CLI, or a plain shell / editor command, running in its own **Hosted PTY** under registry key `${taskId}::${tabId}`. The PTY-world successor to the tmux **ChatTab**, reusing the same chord ids: ctrl+t new, ctrl+e choose engine (incl. "shell" as a first-class tab type), ctrl+w close (last tab refuses), F2 rename, ctrl+]/[ cycle. Title precedence: manual rename > live OSC window title > first-prompt auto-title > vendor default. Per-task tab state (incl. the **Split** tree) persists so a restart rehydrates tabs; an engine tab whose CLI exits **degrades in place to a shell** (`degradeToShell`), and a tab whose engine died while the TUI was away resumes via `--resume <sessionId>` (one attempt).
_Avoid_: chattab (the tmux window), window, terminal (unqualified — that's the pane component).

**Split**:
The split tree inside one **Terminal Tab** (`src/tui-react/workspace/TerminalSplit.tsx`, an adapter over the content-agnostic `src/tui/workspace/split-core.ts`). `ctrl+\` splits right, `ctrl+=` splits down (new leaves run the user's shell in the same **Worktree**), F3 cycles leaf focus; a leaf whose process exits collapses tmux-style, and the LAST leaf's exit fires the tab-level `onExit` (the degrade/close decision stays with **Terminal Tab**). Stored on the tab (`TerminalTab.splitTree`).
_Avoid_: pane (a split leaf is not a **Pane**), tmux pane.

**Terminal pane**:
The embedded-terminal component (`src/tui-react/panes/terminal/Terminal.tsx` plus the shared render/input cluster in `src/tui/panes/terminal/` — viewport slicing, SGR→StyledText conversion, key-event→byte translation). Acquires its PTY from the **PTY Registry** and never kills it — unmount is not session end.
_Avoid_: terminal emulator, xterm (that's the VT engine inside the backend).

**PTY Registry**:
The per-process container decoupling pane lifecycle (per-render) from session lifecycle (`src/tui/panes/terminal/registry.ts`, `getDefaultPtyRegistry()`): `acquire` returns the live PTY under the same key or creates one; `release`/`releaseWhere` kill (task archive/delete); `detachAll` on app teardown. Owns **PTY parking** (issue #28): a periodic sweep detaches handles with no subscriber for 2 minutes — the child keeps running in the **PTY Host**, the local xterm instance is dropped and GC'd; switching back reattaches and replays.
_Avoid_: pty pool, cache.

**PTY Host**:
The standalone `kobe pty-host` process (`packages/kobe-daemon/src/daemon/pty-server.ts`; CLI shim `src/cli/pty-host-cmd.ts`) that owns the raw PTY children — kobe's tmux-server analog. Deliberately separate from the **Daemon** so engine sessions survive both quitting the TUI and `kobe daemon restart`; keeps a byte ring buffer per session and replays it on reattach; tracks each session's live OSC title/pid/command (`kobe api pty-list`); idle-exits at zero sessions. Only `pty.kill` (tab close, task archive) or `kobe reset` ends children.
_Avoid_: pty daemon, sidecar (that's kobe-web's Node PTY process).

**Hosted PTY**:
A terminal-backend handle whose child lives in the **PTY Host** (`HostedTaskPty`, `src/tui/panes/terminal/pty-hosted.ts`) — the DEFAULT backend. VT emulation stays in the TUI process (`pty-xterm-base.ts`); only raw bytes cross the socket. `kill()` ends the remote child; `detach()` drops just this handle and leaves the child running. The local-child backend (`pty.ts`) and pipe fallback (`pty-pipe.ts`) still exist for non-persistent uses; they cannot detach and are never parked.
_Avoid_: remote pty (that's the SSH/remote-projects sense).

**Terminal Identity Boundary**:
The environment boundary between a terminal child and the VT parser it immediately talks to. A child inside the **Workspace Host** talks to kobe's xterm parser, not to an outer iTerm2 or Terminal.app, so every spawn path uses `embeddedTerminalEnv`: advertise embedded-terminal capabilities (`TERM=xterm-256color`, `COLORTERM=truecolor`) but strip outer-emulator identity (`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`). This policy covers **Hosted PTY**, local Bun PTY, pipe fallback, and the web PTY sidecar.

SSH appeared correct because it normally forwards `TERM` but not `TERM_PROGRAM` or `TERM_PROGRAM_VERSION`. Remote Neovim therefore stayed on its xterm-compatible color path. Locally, the contradictory pair `TERM=xterm-256color` plus inherited `TERM_PROGRAM=iTerm.app` made Neovim emit iTerm's short colon RGB form (`38:2:R:G:B`); xterm.js follows the fixed T.416 field positions and interpreted the channels differently, producing the yellow/olive cast. Explicitly forwarding the outer identity over SSH can reproduce the same failure.

The identity at each nested-terminal or multiplexer boundary must describe the immediate parser, never an ancestor emulator. Fix the spawn boundary rather than application-specific configuration or user Neovim state.
_Avoid_: outer terminal passthrough, Neovim color workaround, terminal config mismatch.

**Focus**:
The single source of truth for which pane has the keyboard (`src/tui-react/context/focus.tsx`): `PaneId = "sidebar" | "workspace" | "files" | "terminal"`, default `sidebar`. Pane wrappers set it on click; `ctrl+h/j/k/l` jump directly (global `focus.numeric`), F4 cycles forward (`focus.next`), `ctrl+q` returns to the sidebar. Pane-scoped plain-letter bindings gate on it — the boundary rule in [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md).
_Avoid_: active pane, selection (that's the sidebar's selected task).

**Binding Stack**:
The module-global LIFO keymap stack. The framework-free dispatcher is `src/tui/lib/keymap-dispatch.ts` (chord matching, preventDefault-on-first-hit, slot-based multiplexed ids, the **modal barrier**); React registration is `useBindings()` in `src/tui-react/lib/keymap.ts`. Chords come from the `KobeKeymap` table (`src/tui/context/keybindings.ts`, re-exported for React via `src/tui-react/context/keybindings.ts`; user overrides in `~/.kobe/settings/keybindings.yaml`) — never hardcode chord strings. React mounts ancestors on top (the inverse of Solid), so parent/child chord overlaps must resolve by GATING, not stack order.
_Avoid_: keymap (unqualified — ambiguous between the `KobeKeymap` table and this runtime stack), hotkeys.

**Dialog Stack**:
The overlay stack in `src/tui-react/ui/dialog.tsx` (`useDialog` → `push`/`pop`/`replace`/`clear`, bodies passed as thunks). The top dialog renders as an absolutely-positioned card over a dim backdrop; esc/ctrl+c pop it (unless a text selection is active). An open dialog pushes a **modal barrier** entry onto the **Binding Stack**, structurally cutting off every binding registered before it — panes never gate themselves on "dialog open".
_Avoid_: modal (name the barrier, not the component), popup.

### Orchestration

**Orchestrator**:
Owns **Task** lifecycle + **Worktree** allocation + the reactive task-list snapshot the TUI subscribes to. Lives in `src/orchestrator/core.ts`. It never touches an interactive engine process — those are owned by tmux (**Handover** mode) or the **PTY Host** (**Workspace Host** mode); it's task index + git + framework-free observable state. TUI-free so the **Daemon** can host it headless.
_Avoid_: manager, coordinator, controller, service.

**Engine Registry**:
The per-vendor wiring table (`src/engine/registry.ts`): history reader, account detector, hook adapter factory, turn detector, default command, plus engine-owned identity/capabilities (`EngineIdentity` / model catalog). Neutral layers (auto-title, settings, panes) ask the registry instead of switching on vendor literals or parsing a vendor's transcript format directly. Custom engines resolve to a documented empty entry.
_Avoid_: engine switch, vendor table.

**State Store**:
The single owner of `~/.config/kobe/state.json` I/O (`src/state/store.ts`): atomic read-merge-write transactions so concurrent kobe processes (TUI, **Tasks pane**, CLI) can't clobber each other's keys. The TUI's `KVProvider` (`src/tui-react/context/kv.tsx`) and the CLI-side `setPersistedString` family are adapters over it.
_Avoid_: kv file, config file (it's UI/process state, not user config — user config lives in `~/.kobe/settings/`).

### Daemon split

**Daemon**:
The long-running process that holds the **Orchestrator** and serves N **TUI Client**s over a Unix socket. One per user. Spawned via `kobe daemon start`. The RPC/channel surface lives in `packages/kobe-daemon/src/daemon/{protocol,handlers}.ts` (task CRUD, subscribe + channels, issues, web transport). It does NOT own engine processes — restarting it must never end a session (that's why the **PTY Host** is separate).
_Avoid_: server, backend, host.

**TUI Client**:
The kobe TUI process attached to a **Daemon**. Owns view-local state (focus, selected task, pane sizes). Does not own **Task** state.
_Avoid_: frontend, UI process.

**RemoteOrchestrator**:
The **TUI Client**-side facade satisfying the slim **Orchestrator** surface by talking to the **Daemon** over the wire (`src/client/remote-orchestrator.ts`). Hydrates a local task mirror on attach, maintained forward via `task.snapshot` events.
_Avoid_: client, proxy, daemon-client.

**DaemonLifetime**:
The policy deciding whether the **Daemon** keeps running and whether its background collectors run (`packages/kobe-daemon/src/daemon/lifetime.ts`). Owns the gui refcount (only `role: "gui"` subscribers hold the daemon's lifetime — panes don't), the collector gate (`hasSubscribers`), and the idle-shutdown grace timer + `stopping` flag. Distinct from `lifecycle.ts`, which kills an EXTERNAL daemon process (restart/reset).
_Avoid_: lifecycle (that's the external-kill path), refcount, shutdown manager.

### Panes

**Pane**:
Two mode-dependent senses. In tmux mode: a kobe-owned process filling a tmux pane inside a **ChatTab** — the **Tasks pane** and the **Ops pane** (the engine and shell panes are not kobe-rendered); each subscribes to the **Daemon** as `role: "pane"`. In the **Workspace Host**: one of the four **Focus** regions (`sidebar` / `workspace` / `files` / `terminal`). Use "tmux pane" for the raw tmux mechanism; a **Split** leaf is never called a pane.
_Avoid_: panel, window, view.

## Relationships

- A **Task** owns exactly one **Worktree**. In tmux mode it also owns one **tmux Session**; in the **Workspace Host** its engine sessions are **Terminal Tab**s, keyed `${taskId}::${tabId}` in the **PTY Registry**.
- tmux mode: a **tmux Session** holds one-or-more **ChatTab**s; each ChatTab has four panes: **Tasks pane**, engine CLI, **Ops pane**, shell. Workspace Host mode: the host mounts Sidebar | **Terminal Tab**s | Files; each Terminal Tab holds one **Hosted PTY** and optionally a **Split** tree. In both modes, each engine session writes one-or-more **Session** transcripts to disk.
- The **Orchestrator** owns all **Task**s; it allocates the **Worktree** lazily on first enter (Handover or `activateTask`).
- The **PTY Host** owns raw PTY children; the **PTY Registry** hands panes **Hosted PTY** handles to them; the **Daemon** owns engine processes in neither mode.
- The **tmux client** is the sole path to the `-L kobe` server; **Session Layout** is the pure policy `ensureSession` applies through it, gated by **Session Decision**.
- A **Daemon** runs one **Orchestrator**; N **TUI Client**s each run one **RemoteOrchestrator** (the Workspace Host as `role: "gui"`, in-tmux helper panes as `role: "pane"`).
- Opening a dialog pushes onto the **Dialog Stack**, which pushes a modal barrier onto the **Binding Stack**.

## Example dialogue

> **Dev:** "When the user presses ⏎ on a task in the **Tasks pane**, what actually happens?"
> **Maintainer:** "A **Handover**. The pane ensures the **Worktree** exists, calls `ensureSession` to build the **tmux Session** (**Session Decision** decides create/reuse/respawn, **Session Layout** builds the commands, both applied through the **tmux client**), then `tmux switch-client`s into it."
>
> **Dev:** "And the same ⏎ in the **Workspace Host**'s sidebar?"
> **Maintainer:** "`activateTask`: ensure the **Worktree**, select the task, focus the `workspace` pane. The mounted **Terminal Tab**s then `acquire` their **Hosted PTY**s from the **PTY Registry** — a live session in the **PTY Host** is reattached and replayed, a missing one is spawned with the engine command from the **Engine Registry**."

## Flagged ambiguities

- **"session"** — three meanings: (a) **Session** = an engine transcript on disk; (b) **tmux Session** = the per-Task tmux session; (c) a **PTY Host** session = a running child under a registry key. Always qualify (b) and (c).
- **"workspace"** — the `workspace` **Focus** pane id (the center column), the **Workspace Host** (the whole `KOBE_TUI=1` app), the abstract "tmux workspace", and the retired capital-W **Workspace** pane. Prefer the qualified forms.
- **"pane"** — a kobe **Pane** process (tmux mode) vs a **Focus** region (Workspace Host) vs a raw tmux pane vs a **Split** leaf (never "pane"). Use "tmux pane" for the mechanism.
- **"tab" / "window"** — a **ChatTab** is a tmux *window*; a **Terminal Tab** is a Workspace Host tab. Never use bare "tab" in a sentence where both stacks are in play.
- **"keymap"** — the `KobeKeymap` chord table vs the runtime **Binding Stack**. The table says WHICH chord; the stack says WHO receives it.

## Retired (v0.5, removed in KOB-226/227)

These no longer exist in the code; kept so old comments/commits resolve:

- **AI Engine Port** — the `AIEngine` spawn/stream interface. kobe doesn't drive claude as a subprocess anymore; only the on-disk history readers (`engine/claude-code-local/history.ts`) survive.
- **SessionPump** — per-(Task, ChatTab) `engine.stream()` consumer. No live stream to pump.
- **PendingInputBroker** — the ExitPlanMode / AskUserQuestion waiting-request map. claude handles its own approvals interactively now.
- **ChatSessionController** — the chat pane's per-tab subscription choreography.
- **Bridge** — the MCP server exposing the Orchestrator to spawned claude.

## Retired (v0.6 outer monitor, removed 2026-06 — retirement record in git history: docs/design/app-retirement.md)

The transitional opentui shell and its surfaces; kept so old comments/commits resolve:

- **Outer monitor** — the `app.tsx` opentui shell (sidebar + Workspace) that `kobe` used to boot into. `kobe` now attaches straight to a **tmux Session** (`tui/direct.ts`) — or boots the **Workspace Host** under `KOBE_TUI=1`.
- **Workspace** (capital W) — the outer shell's right **Pane**: **Live Preview** + a **Handover** launcher (`ClaudeLauncher`), or the **Cost Dashboard**. Don't reuse the capitalized word for a UI region.
- **Live Preview** — the Workspace's ~1s `tmux capture-pane` view of a Task's claude pane. Dropped without a port: switching sessions *is* the preview.
- **Cost Dashboard** — the Workspace's per-Task token table. Dropped without a port, along with the `monitor/cost.ts` summarizer chain.
- **`KOBE_NO_DAEMON`** — env flag that hosted a daemon-less in-process **Orchestrator** inside the TUI. Retired: the **Daemon** is the product; `kobe doctor` / `kobe reset` cover its failure modes.

## Retired (Solid TUI + native-chat exploration, removed 2026-07)

The pure-TUI pivot's casualties; kept so old comments/commits resolve:

- **Solid TUI** — the `@opentui/solid` implementation of every pane/host and its `KOBE_SOLID=1` escape hatch (removed in 0.7.73, 2026-07-07). React under `src/tui-react/**` is the only UI. The final `solid-js` dependency was removed when Orchestrator/client signals converged on the framework-free observable-state Module.
- **Native chat pane / Provider Runtime (AI SDK harness)** — the `KOBE_TUI=1` center column briefly rendered its own chat over an AI-SDK harness (`src/engine/ai-sdk/harness-turn.ts`; decision doc [`docs/design/provider-runtime.md`](./docs/design/provider-runtime.md), exploration note [`docs/design/provider-runtime-harness.md`](./docs/design/provider-runtime-harness.md)). Deleted 2026-07-06: the center column now embeds the engine's own TUI in a PTY (**Terminal Tab**), so kobe never re-renders a chat stream. The design docs remain as history.
