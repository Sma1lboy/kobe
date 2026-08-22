/**
 * UI-facing daemon RPC handlers — the broadcast/report family the TUI and
 * plugin CLI drive (`session.deliver`, `ui.reportEvent`, `tab.open`,
 * `notice.send`, `note.file`) plus the host-dialog prompt pair
 * (`ui.prompt` / `ui.promptReply`). Split out of `handlers.ts` for the
 * repo's 500-line file-size cap; see its doc comment for the registry's
 * wire-compatibility contract (byte-equivalent payloads, key order
 * load-bearing) — unchanged here.
 */

import { randomUUID } from "node:crypto"
import { optionalString, requireString } from "./handler-validators.ts"
import type { DaemonRequestHandler } from "./handlers.ts"
import { displayTaskTitle } from "./protocol.ts"

/** `ui.prompt` timeout bounds — a plugin must not hang the CLI forever. */
const PROMPT_DEFAULT_TIMEOUT_MS = 120_000
const PROMPT_MAX_TIMEOUT_MS = 600_000

export const UI_HANDLERS: readonly DaemonRequestHandler[] = [
  {
    name: "session.deliver",
    async handle(payload, ctx) {
      // Dispatcher messenger (docs/design/dispatcher.md): `kobe api
      // dispatch` routes text to a task's live engine session. The daemon
      // only validates + broadcasts; the front-end hosting that session
      // (the SPA via /pty/send) owns the actual paste.
      const taskId = requireString(payload, "taskId")
      const text = requireString(payload, "text")
      const tabId = optionalString(payload, "tabId")
      const source = optionalString(payload, "source")
      if (source !== undefined && source !== "note" && source !== "dispatcher") {
        throw new Error('source must be "note" or "dispatcher"')
      }
      if (!ctx.orch.getTask(taskId)) throw new Error(`task not found: ${taskId}`)
      ctx.bus.publish("session.deliver", {
        taskId,
        text,
        ...(tabId !== undefined ? { tabId } : {}),
        at: Date.now(),
        source: source ?? "dispatcher",
      })
      // Report reach, don't just claim success. `session.deliver` is
      // broadcast-only — an attached client performs the paste — so with
      // nothing listening the text goes into the void while the caller still
      // reads `ok: true`. That is how a dispatched answer goes missing and
      // leaves a `permission_needed` badge stranded.
      //
      // `clients` counts CONNECTIONS, which is a weak proxy: the calling CLI
      // is itself one, so 1 does not prove a session host is listening. It
      // still distinguishes the unambiguous 0 case, and the caller can
      // confirm a real host with `api pty-list`.
      return { ok: true, clients: ctx.daemon.clientCount() }
    },
  },
  {
    name: "ui.reportEvent",
    async handle(payload, ctx) {
      // Fire-and-forget: the TUI reports a UI moment; plugins are the only
      // consumer (same no-broadcast rationale as engine lifecycle kinds).
      const kind = requireString(payload, "kind")
      if (!kind.match(/^(file\.(will-open|opened|closed)|task\.opened|project\.opened|tab\.(opened|closed))$/)) {
        throw new Error(`unknown ui event kind: ${kind}`)
      }
      const taskId = optionalString(payload, "taskId")
      const detail = payload.detail
      ctx.plugins?.handleUiReport({
        kind: kind as import("../plugins/manifest.ts").PluginEventName,
        ...(taskId ? { taskId } : {}),
        ...(detail && typeof detail === "object" && !Array.isArray(detail)
          ? { detail: detail as Record<string, unknown> }
          : {}),
      })
      return {}
    },
  },
  {
    name: "ui.prompt",
    async handle(payload, ctx) {
      // Host-provided input dialog (plugins → `kobe api prompt`): publish
      // the request to every attached TUI and block until one answers via
      // `ui.promptReply` or the broker times out. First answer wins.
      const broker = ctx.prompts
      if (!broker) throw new Error("prompt broker unavailable")
      const title = requireString(payload, "title")
      const placeholder = optionalString(payload, "placeholder")
      const initial = optionalString(payload, "initial")
      const rawTimeout = (payload as { timeoutMs?: unknown }).timeoutMs
      const timeoutMs = Math.min(
        typeof rawTimeout === "number" && rawTimeout >= 1000 ? rawTimeout : PROMPT_DEFAULT_TIMEOUT_MS,
        PROMPT_MAX_TIMEOUT_MS,
      )
      const promptId = randomUUID()
      const result = broker.create(promptId, timeoutMs)
      ctx.bus.publish("ui.prompt", {
        promptId,
        title,
        ...(placeholder ? { placeholder } : {}),
        ...(initial ? { initial } : {}),
        at: Date.now(),
      })
      return await result
    },
  },
  {
    name: "ui.promptReply",
    async handle(payload, ctx) {
      const broker = ctx.prompts
      if (!broker) throw new Error("prompt broker unavailable")
      const promptId = requireString(payload, "promptId")
      const value = optionalString(payload, "value")
      const settled = broker.settle(
        promptId,
        value !== undefined ? { value } : { cancelled: true, reason: "cancelled" },
      )
      return { ok: settled }
    },
  },
  {
    name: "tab.open",
    async handle(payload, ctx) {
      // Plugin panes: `kobe plugin pane open` asks the TUI hosting the
      // task to open a terminal tab running argv. Same trust boundary as
      // `pty.open` (the socket already grants argv execution); the daemon
      // only validates + broadcasts, the TUI owns the actual tab.
      const taskId = requireString(payload, "taskId")
      const title = requireString(payload, "title")
      const argv = (payload as { argv?: unknown }).argv
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string" && a.length > 0)) {
        throw new Error("argv must be a non-empty array of strings")
      }
      if (!ctx.orch.getTask(taskId)) throw new Error(`task not found: ${taskId}`)
      const placement = optionalString(payload, "placement")
      const direction = optionalString(payload, "direction")
      const tabId = optionalString(payload, "tabId")
      ctx.bus.publish("tab.open", {
        taskId,
        argv,
        title,
        ...(tabId !== undefined ? { tabId } : {}),
        ...(placement === "tab" || placement === "split" ? { placement } : {}),
        ...(direction === "right" || direction === "down" ? { direction } : {}),
        at: Date.now(),
      })
      return { ok: true }
    },
  },
  {
    name: "tab.close",
    async handle(payload, ctx) {
      // Inverse of tab.open: ask the TUI hosting the task to close every
      // pane (split leaf / command tab) opened under `title`. Deliver-only
      // broadcast — the daemon validates, the TUI owns the actual close.
      const taskId = requireString(payload, "taskId")
      const title = requireString(payload, "title")
      const tabId = optionalString(payload, "tabId")
      if (!ctx.orch.getTask(taskId)) throw new Error(`task not found: ${taskId}`)
      ctx.bus.publish("tab.close", {
        taskId,
        title,
        ...(tabId !== undefined ? { tabId } : {}),
        at: Date.now(),
      })
      return { ok: true }
    },
  },
  {
    name: "notice.send",
    async handle(payload, ctx) {
      // `kobe api notify`: one toast for every attached UI. The daemon
      // only validates + broadcasts; NotificationsProvider in each
      // subscribed host renders it (and dedupes replays on `at`).
      const title = requireString(payload, "title")
      // Free-form kind: known severities get styled by the TUI, anything
      // else renders neutrally — agents may invent their own vocabulary.
      const kind = optionalString(payload, "kind") ?? "done"
      if (kind.trim() === "") throw new Error("kind must be a non-empty string")
      const taskId = optionalString(payload, "taskId")
      if (taskId !== undefined && !ctx.orch.getTask(taskId)) throw new Error(`task not found: ${taskId}`)
      const source = optionalString(payload, "source")
      ctx.bus.publish("notice.event", { title, kind, taskId, at: Date.now(), source })
      return { ok: true }
    },
  },
  {
    name: "note.file",
    async handle(payload, ctx) {
      // Field note (docs/design/dispatcher.md): a worktree session files a
      // one-line resolved gotcha. The daemon's only intelligence is
      // ADDRESSING — find the author's repo's dispatcher seat (the main
      // session) and forward over session.deliver with provenance. WHO
      // benefits from the note is the dispatcher agent's judgment, not
      // daemon code.
      const taskId = requireString(payload, "taskId")
      const text = requireString(payload, "text")
      const author = ctx.orch.getTask(taskId)
      if (!author) throw new Error(`task not found: ${taskId}`)
      const label = displayTaskTitle(author) || taskId
      // Persist BEFORE routing: relaying is best-effort and needs a live
      // dispatcher seat, but the durable record is the point — a note filed
      // with no dispatcher running must still reach the NEXT session
      // (repo-init injection reads this store). A store failure must never
      // error a working agent, so it degrades to routing-only.
      const persisted = await ctx.notes
        ?.append(author.repo, { at: new Date().toISOString(), text, taskId, author: label })
        .then(() => true)
        .catch(() => false)
      const main = ctx.orch
        .listTasks()
        .find((t) => (t.kind ?? "task") === "main" && t.repo === author.repo && !t.archived)
      // No dispatcher seat, or the dispatcher noting to itself: accepted
      // but unrouted — filing must never error a working agent. Still
      // persisted above, which is why an unrouted note is no longer a loss.
      if (!main || main.id === author.id) return { ok: true, routed: false, persisted: persisted ?? false }
      ctx.bus.publish("session.deliver", {
        taskId: main.id,
        text: `[KOBE FIELD NOTE] from "${label}" (task ${taskId}): ${text}`,
        at: Date.now(),
        source: "note",
      })
      return { ok: true, routed: true, persisted: persisted ?? false }
    },
  },
  {
    name: "note.list",
    async handle(payload, ctx) {
      // Newest-first field notes for a repo. Read by `kobe api note-list` and
      // by the worktree launch path that seeds a fresh session with them.
      const repo = requireString(payload, "repo")
      return { notes: (await ctx.notes?.list(repo)) ?? [] }
    },
  },
]
