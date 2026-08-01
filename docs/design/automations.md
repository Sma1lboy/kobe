# Automations — scheduled agent tasks

> Daemon-owned cron. A schedule + a prompt + a repo; every firing creates a
> fresh task and starts its engine with that prompt.

## What it is

```text
Automation = cron rule + prompt + repo
Firing     = a new Task (worktree + branch + engine session)
```

The unit of work is an ordinary kobe task, not a hidden background job. A run
that fired at 09:00 is a task in the sidebar you can open, read, and keep
talking to. That is the whole point of modelling it this way: scheduled work
that produces something you cannot inspect is not worth scheduling.

Typical use: *"every weekday at 09:00, audit the dependencies of this repo and
summarize risky changes."*

## Data model

Two records, both in `<KOBE_HOME>/.kobe/automations.json` (daemon is the only
writer). Types in [`contracts.ts`](../../packages/kobe-daemon/src/daemon/contracts.ts).

- **`Automation`** — the rule. `schedule` (five-field cron), `prompt`, `repo`,
  optional `vendor` / `baseRef` / `precheck`, `enabled`, `nextRunAt`,
  `missedRunGraceMinutes`.
- **`AutomationRun`** — one firing. `scheduledFor` (when it *should* have run),
  `status`, `trigger`, and the `taskId` it produced. Capped at 100 per
  automation.

### Run statuses

| Status | Meaning |
|---|---|
| `dispatched` | Task created, engine started with the prompt |
| `skipped_precheck` | The precheck said there was nothing to do — **healthy** |
| `skipped_missed` | The occurrence was older than the grace window |
| `skipped_unavailable` | The repo/worktree could not be resolved |
| `dispatch_failed` | Task created but its engine did not start |

The four "didn't run" reasons are deliberately distinct. Unattended automation
is only trustworthy if a glance tells you whether a human is needed;
`skipped_precheck` and `dispatch_failed` are opposite signals and must not
share a label.

## Scheduling

`nextRunAt` is an **absolute timestamp on disk**, never an in-memory timer.
That single decision answers the restart question: a daemon that restarts (or
was down for a day) re-discovers every armed schedule on its first sweep, with
no re-arm pass. Same shape as `Task.quotaResume` and `TaskDeletionState`.

The sweep ([`automation-runner.ts`](../../packages/kobe-daemon/src/daemon/automation-runner.ts))
runs every 60s, and like the quota-resume runner it is **not** gated on
`hasSubscribers` — a schedule that requires an audience is not a schedule.

Cron parsing is hand-rolled ([`cron.ts`](../../packages/kobe-daemon/src/daemon/cron.ts)),
pure JS, no dependency: the repo has no scheduling deps and `bun build --compile`
bans native addons. Two functions, and the second is the interesting one:

- `nextCronAfter(expr, after)` — advance past a firing (strictly after, or the
  sweep would re-fire what it just ran)
- `latestCronAtOrBefore(expr, now, notBefore)` — *what should have run by now*,
  which is the question missed-run compensation actually asks

Day matching follows the Vixie rule: with BOTH day-of-month and weekday
restricted they are OR'd (`0 0 1 * MON` = the 1st **or** any Monday).

### Missed runs

Daemon down at 09:00, back at 09:20, grace 60m → the occurrence runs late.
Back at 14:00 → `skipped_missed`.

Only the **most recent** missed occurrence is ever considered. Three days
offline produces one run, not three — a stampede at boot is worse than a gap.

## Precheck

```bash
--precheck "git log --since=24.hours --oneline | grep -q ."
```

Runs in the repo through the login shell before the engine starts. Exit 0
proceeds; anything else — non-zero, timeout, spawn failure — skips **without
creating a task**.

This is the cost control. The dominant waste in scheduled agent work is firing
on time when nothing changed: the engine still boots, reads the repo, and burns
a turn to conclude "nothing to do". A shell command answers that for free.

Failing closed is deliberate. A broken precheck must not silently degrade into
"run every time", which is exactly the cost it exists to avoid. `automation-run-now`
skips the precheck entirely — asking for it by hand IS the answer.

## Daemon lifetime

kobe's daemon normally self-stops 3s after the last GUI detaches. **An enabled
automation holds it open** (`DaemonLifetime.keepAlive`), because a schedule that
only fires while someone is watching kobe is not a schedule.

The hold is opt-in by construction — the user created the automation — and
releases when the last one is deleted or disabled, restoring ordinary idle
shutdown. `daemon.status` reports `automationHold` so a daemon staying up for a
schedule does not read as a leak.

Releasing needs an explicit nudge: arming is otherwise driven only by GUI
disconnects, so deleting the last automation after the GUI already left would
leave nothing to notice. Every automation mutation calls
`lifetime.reevaluateIdle()`.

## TUI

`ctrl+a` `u` opens the Automations page (PROPOSED chord — see
[KEYBINDINGS.md](../KEYBINDINGS.md)). It is the triage half of the feature:
what is scheduled, when each fires next, and what the last runs did. The header
says whether an enabled automation is currently holding the daemon open.

`j`/`k` move, `e` pauses/resumes, `s` runs one now (skipping its precheck), `d`
deletes, `enter` opens the task from the most recent run, `r` refreshes.

Creating one stays on the CLI: it needs a repo, a prompt, a cron expression,
and optionally a precheck command — a form, not a list row.

## CLI

```bash
kobe api automation-create --repo . --name "weekday audit" \
  --prompt "Audit dependencies and summarize risky changes." \
  --schedule "0 9 * * MON-FRI" \
  --precheck "gh pr list --json number -q '.[0].number'"

kobe api automation-list
kobe api automation-runs --id <id>
kobe api automation-run-now --id <id>
kobe api automation-set-enabled --id <id> --enabled false
kobe api automation-delete --id <id>
```

Full flag list: `kobe api schema --group automation`.

## Prompt delivery

The prompt rides the engine's **own argv** via
`buildEngineSessionLaunch`'s `promptIntent: {kind: "explicit"}` — it is part of
the spawn, not a paste that follows it. A cold engine TUI can swallow a raced
paste, and an unattended run has nobody watching to retype it.

## Not implemented

- Reusing an existing task instead of creating one per run
- Timezones (the daemon host's local time)
- Cost attribution per run, remote/SSH execution targets
