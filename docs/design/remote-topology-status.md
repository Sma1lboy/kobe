# Remote topology (SSH-backed projects) — status assessment, 2026-07-27

Assessment of the `remote-projects` branch and the current state of the
reverse-topology feature (kobe local, project on a remote host over SSH).
Verified against code on current `main` (v0.8.19, commit `d31fbf31`), not
against the branch summary.

## Headline: there is nothing to rebase

The `remote-projects` branch (head `7cf626f4`) was **already merged into main
on 2026-06-09** via merge commit `4789df06` ("Merge remote-projects:
experimental SSH-backed projects (off by default)"). The branch is a full
ancestor of main:

- Commits ahead of main: **0**
- Commits behind main: **1139**
- Merge-base = branch head (`7cf626f4`)

So the "badly stale branch that needs reviving" premise is stale itself. Main
has been carrying and actively maintaining the code for ~7 weeks — the
CHANGELOG shows post-merge remote-project work (RemoteExecHost caching by
ControlMaster socket, `kobe remove` of `ssh://` entries, a fix for remote
projects silently breaking engine-activity collection, ExecHost-backed
worktree content reads, ssh-arg quoting). The branch's changeset
(`remote-projects-experimental.md`) was consumed by a release long ago;
`.changeset/` on main contains no pending entries. No resurrection risk
because no commits are being carried forward.

The local `remote-projects` branch ref is now historical. It can be retired
(owner call — nothing here deletes it).

## What phases 1–6 actually contain (verified in code on main)

Design source of truth: `docs/design/remote-projects.md` — which is itself
maintained on main and already accurate.

| Phase | Claim | Verified state on main |
|---|---|---|
| 1. ExecHost seam | Done | `packages/kobe/src/exec/exec-host.ts` — `LocalExecHost` / `RemoteExecHost` / pure ssh construction (`sshConnectArgs`, `remoteShellCommand`, `shQuote`) + ControlMaster `ensureReady`. `exec/resolve.ts` — `execHostForRepo` / `execHostForWorktreePath`. Tests pass. |
| 2. Keychain | Done | `packages/kobe/src/exec/keychain.ts` — macOS `security` store/read/delete behind injected deps; non-darwin no-op. Tests pass. |
| 3. Data model | Done | `packages/kobe/src/state/repos.ts` — `RemoteRepoConfig`, `remoteRepos` map, synthetic `ssh://user@host[:port]` savedRepos keys, `resolveRepoRoot` ssh:// passthrough, `isRemoteProjectsEnabled()` experimental gate. `remoteControlSocketPath` in `env.ts`. Tests pass. |
| 4. CLI | Done | `packages/kobe/src/cli/add-remote.ts` — `kobe add --remote --host --user --path [--port] [--key|--password]`; refuses when the experimental flag is off. Tests pass. |
| 5. Remote worktree | Done | `GitWorktreeManager` routes git+fs through `orchestrator/worktree/exec-deps.ts`; `paths.ts` `remoteWorktreePathFor`; new remote worktrees use `<basePath>/.rove/worktrees` and legacy `.kobe/worktrees` remains recognized. Tests pass. |
| 6. Engine launch over SSH | **REGRESSED / disconnected** | The original phase-6 launch was wired through the tmux runtime, which was retired in the embedded-terminal pivot. `ExecHost.wrapCommand` (the `ssh -tt … 'cd <wt> && <engine>'` builder) still exists but has **zero consumers** outside `exec-host.ts`. The current shared launch builder `packages/kobe/src/engine/session-launch.ts` has no remote/ssh/ExecHost awareness — a task under a remote project would get its worktree created remotely but its engine launched locally (against a cwd that doesn't exist locally). |

Feature gate: `experimental.remoteProjects`, off by default, toggled at
Settings → Dev → Experimental (React surface:
`tui-react/component/settings-dialog/sections-misc.tsx`, persisted through
`getPersistedBool`).

Graceful degradation already on main: the daemon's worktree-changes and
transcript-activity collectors explicitly **skip** `ssh://` projects (their
files aren't on this filesystem), so a remote project no longer poisons
telemetry — that was a real post-merge bug, fixed (`4fa4da8`).

## Gate status (this worktree, on main)

- Repo-root `bun run lint` — clean (763 files).
- Repo-root `bun run typecheck` (kobe-daemon + kobe) — clean.
- Repo-root `bun run test` (fast + socket tracks) — all pass, exit 0.
- Remote-specific suites run explicitly: `test/exec/*` (exec-host, keychain,
  local-exec-host, remote-repos), `test/cli/add-remote.test.ts`,
  `test/orchestrator/worktree-remote.test.ts` — 6 files, 58 tests, all pass.

No mechanical breakage to fix: main never let this code rot.

## What only a human with a live SSH host can validate

None of the above is live-host validation. Everything below is untested
against a real remote and cannot be claimed working:

1. `kobe add --remote` end-to-end: connectivity probe, ControlMaster socket
   creation under `<ROVE_HOME>/.rove/ssh/`, key and password (keychain +
   `sshpass -e`) auth paths, `StrictHostKeyChecking=accept-new` TOFU flow.
2. Remote worktree creation: `git worktree add` over SSH against a real repo
   at `basePath`, path quoting on hosts with unusual shells, latency behavior
   of the multiplexed connection under the sidebar's poll cadence.
3. Password path prerequisites: `sshpass` is not on macOS by default — the
   prerequisite surfacing needs a real check.
4. Anything phase-6: engine-over-SSH launch (once reconnected), resume /
   reattach, additional tabs, headless prompt delivery.

## What phases 7–8 require (not started)

- **Phase 7 — FS panes over SSH:** route filetree git reads, ops diff/file
  reads, and the sidebar changes chip through
  `execHostForWorktreePath(cwd)`; the sidebar's sync 2s poll must become
  async + last-known-cache for remote (a sync SSH call freezes the TUI; keep
  the sync fast-path local). The ExecHost `readFile`/`run` seam is ready;
  the work is plumbing the pane readers. Note: some groundwork landed
  post-merge (`worktree/content.ts` ExecHost-backed reads for file tree /
  ops preview / web diff — CHANGELOG `9d8fd19`).
- **Phase 8 — deferred/degrade:** repo init script + first prompt executed
  on the remote (today skipped for remote; the once-per-worktree marker must
  key on the remote worktree), telemetry via remote transcript proxying (or
  keep the current explicit skip), web diff route, new-task-dialog remote
  tab / sidebar remote-project card (today CLI-only registration).

## Recommended landing sequence

1. **Retire the branch mentally (and eventually the ref — owner's call).**
   All future remote-topology work starts from fresh `main`; the branch has
   nothing main doesn't.
2. **Phase 6 reconnection first** — it's the regression, and without it the
   feature is "remote worktree, local engine", which is worse than off.
   Thread the task's ExecHost into `engine/session-launch.ts`: wrap the
   final command with `wrapCommand({ tty: true, cwd: remoteWt })`, use a
   valid local spawn cwd for the PTY child, and make sure **every** launch
   path (initial, extra tabs, resume/reattach, headless prompt delivery)
   goes through the same wrapper — the design doc's "known traps" list is
   the checklist. Keep it behind the existing experimental flag.
3. **First live-host smoke test (human)** — phases 1–5 + reconnected 6
   against a real SSH host before building anything else on top. This is the
   highest-information cheap step and has never happened.
4. **Phase 7** (async sidebar chip + pane readers via ExecHost), then
   **phase 8** in the design doc's order.
5. Update `docs/design/remote-projects.md` status header at each step — it
   is currently accurate; keep it that way.

## Top risks

- Phase 6 has silently regressed once already (tmux retirement). Without a
  behavior test asserting "remote task ⇒ launch command is ssh-wrapped",
  the next launch-path refactor can do it again.
- Zero live-host validation to date: quoting, auth, and ControlMaster
  lifecycles are exactly the kind of code that looks green in unit tests and
  breaks on a real host.
- The sidebar's sync polling model is structurally incompatible with remote
  latency; phase 7 must not be attempted by "just pointing the existing sync
  calls at RemoteExecHost".
