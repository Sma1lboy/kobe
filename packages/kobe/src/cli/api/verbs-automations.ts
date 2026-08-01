/**
 * The `routine` verb group — daemon-owned scheduled agent tasks. Split out
 * of `verbs.ts` (file-size cap); spread back into the {@link VERBS} table
 * there, so schema/help/validation see one canonical list.
 *
 * Every firing creates a FRESH task (worktree + branch + engine session) with
 * the automation's prompt as its first message. Mechanics live in
 * `docs/design/automations.md`.
 */

import { F } from "./flags.ts"
import { simpleRpc } from "./handler-helpers.ts"
import type { VerbSpec } from "./types.ts"

const SCHEDULE_FLAG = {
  name: "schedule",
  type: "string",
  placeholder: "CRON",
  description: "Five-field cron in the daemon host's local time, e.g. '0 9 * * MON-FRI'.",
} as const

const PRECHECK_FLAGS = [
  {
    name: "precheck",
    type: "string",
    placeholder: "CMD",
    description:
      "Shell command run in the repo BEFORE the engine starts. Non-zero exit skips the run without spawning an agent — the cheap way to avoid burning a turn when nothing changed.",
  },
  {
    name: "precheck-timeout",
    type: "int",
    placeholder: "SEC",
    description: "Seconds before the precheck is killed and the run skipped (default 120).",
  },
] as const

const GRACE_FLAG = {
  name: "grace",
  type: "int",
  placeholder: "MIN",
  description:
    "How late a missed occurrence may still run when the daemon was down (default 60). Only the most recent missed occurrence is ever run.",
} as const

/** Shared `--precheck` → payload shape. `--precheck ''` clears it on update. */
function precheckPayload(ctx: Parameters<VerbSpec["handler"]>[0]): Record<string, unknown> {
  const command = ctx.args.str("precheck")
  if (command === undefined) return {}
  if (command.length === 0) return { precheck: null }
  return { precheck: { command, timeoutSeconds: ctx.args.int("precheck-timeout") ?? 120 } }
}

export const ROUTINE_VERBS: readonly VerbSpec[] = [
  {
    name: "routine-list",
    summary: "List scheduled automations with their next run time.",
    flags: [],
    handler: (ctx) => simpleRpc(ctx, "automation.list", {}),
  },
  {
    name: "routine-create",
    summary:
      "Schedule a prompt. Each firing creates a fresh task (worktree + engine) and delivers it. An enabled automation keeps the daemon alive so it fires with no TUI attached.",
    flags: [
      F.repo(),
      { name: "name", type: "string", required: true, placeholder: "N", description: "Automation name." },
      F.prompt(true, "Text delivered as the new session's first message."),
      { ...SCHEDULE_FLAG, required: true },
      F.vendor(),
      {
        name: "base-branch",
        type: "string",
        placeholder: "B",
        description: "Base ref each run's worktree branches from.",
      },
      ...PRECHECK_FLAGS,
      GRACE_FLAG,
      { name: "disabled", type: "bool", description: "Create it paused instead of active." },
    ],
    handler: (ctx) =>
      simpleRpc(ctx, "automation.create", {
        repo: ctx.args.requirePath("repo"),
        name: ctx.args.require("name"),
        prompt: ctx.args.require("prompt"),
        schedule: ctx.args.require("schedule"),
        ...(ctx.args.vendor() ? { vendor: ctx.args.vendor() } : {}),
        ...(ctx.args.str("base-branch") ? { baseRef: ctx.args.str("base-branch") } : {}),
        ...precheckPayload(ctx),
        ...(ctx.args.int("grace") !== undefined ? { missedRunGraceMinutes: ctx.args.int("grace") } : {}),
        ...(ctx.args.bool("disabled") ? { enabled: false } : {}),
      }),
  },
  {
    name: "routine-update",
    summary: "Change an automation. A new --schedule re-anchors its next run; --precheck '' clears the precheck.",
    flags: [
      { name: "id", type: "string", required: true, placeholder: "ID", description: "Automation id." },
      { name: "name", type: "string", placeholder: "N", description: "New name." },
      F.prompt(false, "New prompt."),
      SCHEDULE_FLAG,
      F.vendor(),
      { name: "base-branch", type: "string", placeholder: "B", description: "New base ref ('' to clear)." },
      ...PRECHECK_FLAGS,
      GRACE_FLAG,
    ],
    handler: (ctx) =>
      simpleRpc(ctx, "automation.update", {
        id: ctx.args.require("id"),
        ...(ctx.args.str("name") !== undefined ? { name: ctx.args.str("name") } : {}),
        ...(ctx.args.str("prompt") !== undefined ? { prompt: ctx.args.str("prompt") } : {}),
        ...(ctx.args.str("schedule") !== undefined ? { schedule: ctx.args.str("schedule") } : {}),
        ...(ctx.args.vendor() ? { vendor: ctx.args.vendor() } : {}),
        ...(ctx.args.str("base-branch") !== undefined ? { baseRef: ctx.args.str("base-branch") } : {}),
        ...precheckPayload(ctx),
        ...(ctx.args.int("grace") !== undefined ? { missedRunGraceMinutes: ctx.args.int("grace") } : {}),
      }),
  },
  {
    name: "routine-set-enabled",
    summary: "Pause or resume an automation. Disabling the last active one releases the daemon's keep-alive hold.",
    flags: [
      { name: "id", type: "string", required: true, placeholder: "ID", description: "Automation id." },
      { name: "enabled", type: "bool", required: true, description: "true to resume, false to pause." },
    ],
    handler: (ctx) =>
      simpleRpc(ctx, "automation.update", { id: ctx.args.require("id"), enabled: ctx.args.bool("enabled") }),
  },
  {
    name: "routine-delete",
    summary: "Delete an automation and its run history. Tasks it already created are untouched.",
    flags: [{ name: "id", type: "string", required: true, placeholder: "ID", description: "Automation id." }],
    handler: (ctx) => simpleRpc(ctx, "automation.delete", { id: ctx.args.require("id") }),
  },
  {
    name: "routine-run-now",
    summary:
      "Run an automation immediately, skipping its precheck (asking for it IS the answer). Does not shift its schedule.",
    flags: [{ name: "id", type: "string", required: true, placeholder: "ID", description: "Automation id." }],
    handler: (ctx) => simpleRpc(ctx, "automation.runNow", { id: ctx.args.require("id") }),
  },
  {
    name: "routine-runs",
    summary:
      "Run history, newest first. Statuses: dispatched, skipped_precheck (nothing to do), skipped_missed, skipped_unavailable, dispatch_failed.",
    flags: [{ name: "id", type: "string", required: true, placeholder: "ID", description: "Automation id." }],
    handler: (ctx) => simpleRpc(ctx, "automation.runs", { id: ctx.args.require("id") }),
  },
]
