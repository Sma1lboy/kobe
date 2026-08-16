/**
 * The engine face of `kobe api`: `engine-list` (what can I launch, and with
 * what command?) and `set-command` (pin a task's launch command).
 *
 * These are the two halves of the dispatch contract. `engine-list` is
 * WYSIWYG on purpose — it prints each entry's raw command line so an agent
 * can copy one, edit a flag, and pass the result straight back as
 * `--command`, without kobe modelling anyone's flags. `set-command` is the
 * write twin: it resolves the command's protocol here (the preset registry
 * lives in kobe's state.json, which the daemon cannot read) and sends both.
 *
 * Spec + handler live together (the PANE_VERB pattern) so `verbs.ts` stays
 * under the file-size cap.
 */

import { GENERIC_PROTOCOL, listEnginePresets, resolveCommandProtocol } from "../../engine/engine-presets.ts"
import { F } from "./flags.ts"
import { simpleRpc } from "./handler-helpers.ts"
import type { VerbContext, VerbSpec } from "./types.ts"

export const ENGINE_LIST_VERB: VerbSpec = {
  name: "engine-list",
  summary:
    "List every engine Rove can launch — built-ins and your registered presets — each with its RAW launch command, exactly as it runs. Copy one into `add --command` / `send --tab new --command` verbatim, or edit its flags first. `protocol` is the adapter Rove speaks to it (history, trust, delivery); `generic` = none, which still runs fine but loses transcript reads. Returns { engines }.",
  flags: [],
  // Presets live in state.json, not the daemon — no RPC, no daemon needed.
  offline: true,
  handler: async () => ({ engines: listEnginePresets() }),
}

export async function setCommand(ctx: VerbContext): Promise<unknown> {
  const command = ctx.args.require("command")
  // The protocol is DERIVED, never declared: this is the same resolution
  // `add --command` runs, so a task's recorded protocol matches what the
  // dispatch face would have picked for the same string. An unrecognisable
  // command records the generic protocol rather than keeping a stale one
  // from a different engine — a wrong protocol points the history reader
  // and trust store at another vendor's files.
  const vendor = resolveCommandProtocol(command)
  await simpleRpc(ctx, "task.setCommand", {
    taskId: ctx.args.require("task-id"),
    command,
    vendor,
  })
  return { ok: true, command, protocol: vendor, ...(vendor === GENERIC_PROTOCOL ? { generic: true } : {}) }
}

export const SET_COMMAND_VERB: VerbSpec = {
  name: "set-command",
  summary:
    "Set a task's engine launch command (takes effect on the next session rebuild). The protocol Rove speaks to it is derived from the command — the result reports which one, `generic` when the command names no engine Rove knows.",
  flags: [F.taskId(), { ...F.command(), required: true }],
  handler: setCommand,
}
