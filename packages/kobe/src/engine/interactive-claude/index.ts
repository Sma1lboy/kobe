/**
 * `InteractiveClaudeEngine` — an {@link AIEngine} that drives an
 * *interactive* `claude` REPL instead of `claude -p`.
 *
 * --- Why this exists (KOB-208) ---
 *
 * As of Claude's 2026-06-15 billing change, `claude -p` / Agent SDK
 * usage is metered against a separate $200/mo allowance and no longer
 * draws on the Claude subscription — only the *interactive* Claude Code
 * REPL keeps billing to the subscription. kobe runs many sessions in
 * parallel, so the $200 ceiling is the wrong shape. This engine keeps
 * kobe's self-rendered UI while routing execution through interactive
 * `claude` so usage stays on the subscription.
 *
 * --- How it works ---
 *
 * Interactive `claude` is a terminal program: it needs a PTY and has no
 * line-delimited JSON protocol. kobe instead:
 *
 *   1. Hosts the interactive `claude` inside a hidden PTY, in a separate
 *      Node child process ({@link ./pty-host.cjs}) — `node-pty`'s data
 *      callback does not fire under Bun 1.3.11.
 *   2. Injects the composer's prompt into that PTY's stdin
 *      ({@link HostClient.sendPrompt}).
 *   3. Renders the conversation by tailing the transcript JSONL that
 *      interactive `claude` writes to `~/.claude/projects/...`
 *      ({@link TranscriptTail}) — the same files `history.ts` reads —
 *      and converting each new record to an {@link EngineEvent}
 *      ({@link recordToEvents}).
 *
 * There is no token-level streaming: the transcript flushes a record at
 * a time, so the chat updates per-message, not per-token.
 *
 * --- Known limitations (out of scope for KOB-208) ---
 *
 * Stateful PTY-only UI — permission/approval dialogs, the slash-command
 * menu, plan mode — is NOT handled. Those surfaces live only in the
 * terminal, never in the transcript, so blind stdin injection during
 * one would be swallowed by the dialog. This engine handles ordinary
 * conversation turns end to end; a turn that triggers an approval
 * dialog will stall. Setting this engine as kobe's default is also a
 * separate decision (see `default-engines.ts`).
 */

import { homedir } from "node:os"
import path from "node:path"
import { deriveSessionUsageMetrics } from "@/session/usage-metrics"
import type {
  AIEngine,
  EngineCapabilities,
  EngineCommandDiscoveryOpts,
  EngineCommandEntry,
  EngineEvent,
  EngineHistory,
  EngineIdentity,
  SessionHandle,
  SessionMeta,
  SpawnOpts,
} from "@/types/engine"
import { findClaudeBinary } from "../claude-code-local/binary"
import { claudeCapabilities, claudeIdentity } from "../claude-code-local/capabilities"
import { listClaudeCommands } from "../claude-code-local/commands"
import {
  deleteHistory as deleteHistoryImpl,
  encodeCwd,
  readHistory as readHistoryImpl,
} from "../claude-code-local/history"
import { listSessionsForCwd } from "../claude-code-local/sessions"
import { recordToEvents } from "./events"
import { HostClient, type InteractiveHost } from "./host-client"
import { TranscriptTail, transcriptSize } from "./transcript-tail"

/** Tunable timing knobs. Defaults are production-correct. */
export interface InteractiveClaudeOpts {
  readonly binaryPathResolver?: () => Promise<string>
  /**
   * Factory for the PTY host. Defaults to a real {@link HostClient};
   * tests inject a fake so turn-completion logic runs without a Node
   * child / `node-pty` / a real `claude`.
   */
  readonly hostFactory?: () => InteractiveHost
  /**
   * Settle delay (ms) after a transcript record carrying a terminal
   * `stop_reason` (end_turn / stop_sequence / max_tokens).
   *
   * claude-code persists one JSONL record *per content block* — a
   * `thinking` block and a `text` block of the same assistant message
   * are separate records that BOTH carry the message's `stop_reason`.
   * Closing the turn on the first terminal record would drop every
   * later block of the same message (the visible reply text). So a
   * terminal record instead (re)arms this short timer; any further
   * record resets it; when it fires the turn is done. Default 1800.
   */
  readonly settleMs?: number
  /**
   * Quiet period (ms) with no new transcript records, after the
   * assistant has replied, before the turn is treated as done. The
   * fallback for a transcript that never carries a `stop_reason` at
   * all. Default 8000.
   */
  readonly quietMs?: number
  /**
   * Hard ceiling (ms) for the assistant to produce its first record
   * after a prompt. Past this with no reply, the turn fails. Default
   * 150000.
   */
  readonly noResponseMs?: number
}

/** Per-turn streaming state. A fresh one is created on every spawn/resume. */
interface RunState {
  readonly queue: EngineEvent[]
  waiters: Array<() => void>
  closed: boolean
  sawAssistant: boolean
  settleTimer: ReturnType<typeof setTimeout> | null
  quietTimer: ReturnType<typeof setTimeout> | null
  hardTimer: ReturnType<typeof setTimeout> | null
}

/** One live interactive session: a PTY host + a transcript tail. */
interface InteractiveSession {
  readonly sessionId: string
  readonly cwd: string
  readonly host: InteractiveHost
  tail: TranscriptTail | null
  run: RunState
}

function newRun(): RunState {
  return {
    queue: [],
    waiters: [],
    closed: false,
    sawAssistant: false,
    settleTimer: null,
    quietTimer: null,
    hardTimer: null,
  }
}

/** Terminal `stop_reason` values — the assistant message is complete. */
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens"])

function projectsDir(): string {
  return path.join(homedir(), ".claude", "projects")
}

export class InteractiveClaudeEngine implements AIEngine {
  readonly identity: EngineIdentity = claudeIdentity
  readonly capabilities: EngineCapabilities = claudeCapabilities

  private readonly sessions = new Map<string, InteractiveSession>()
  private readonly binaryPathResolver: () => Promise<string>
  private readonly hostFactory: () => InteractiveHost
  private readonly settleMs: number
  private readonly quietMs: number
  private readonly noResponseMs: number

  constructor(opts: InteractiveClaudeOpts = {}) {
    this.binaryPathResolver = opts.binaryPathResolver ?? findClaudeBinary
    this.hostFactory = opts.hostFactory ?? (() => new HostClient())
    this.settleMs = opts.settleMs ?? 1_800
    this.quietMs = opts.quietMs ?? 8_000
    this.noResponseMs = opts.noResponseMs ?? 150_000
  }

  async spawn(cwd: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    const claudeBin = await this.binaryPathResolver()
    const host = this.hostFactory()
    await host.start({
      claudeBin,
      cwd,
      args: buildClaudeArgs(opts),
      env: opts?.env,
      projectsDir: projectsDir(),
    })
    // The host queues the prompt internally until the REPL has drawn
    // its input box, so it is safe to send before the session is known.
    host.sendPrompt(prompt)

    const { sessionId, jsonlPath } = await host.onSession()
    // Fresh session: the whole transcript is this conversation, so tail
    // from offset 0. The user's own prompt record is dropped by the
    // mapper (kobe echoes user text from the composer).
    return this.attach({ sessionId, cwd, host, jsonlPath, startOffset: 0 })
  }

  async resume(sessionId: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    const cwd = opts?.cwd ?? opts?.env?.KOBE_RESUME_CWD ?? process.cwd()

    // Fast path: the PTY host for this session is still alive — just
    // start a new turn on it. The tail is already forward-tailing, so
    // the new run picks up records appended after this prompt.
    const live = this.sessions.get(sessionId)
    if (live?.host.isAlive()) {
      // Close the prior turn's run (clears its timers) before swapping
      // in a fresh one, so a stale timer can't close the new run.
      this.closeRun(live.run, { type: "done" }, /* onlyIfOpen */ true)
      live.run = newRun()
      this.armTimers(live.run)
      live.host.sendPrompt(prompt)
      return { sessionId, cwd }
    }

    // Cold path: host gone (kobe restart, crash). Respawn interactive
    // `claude --resume <id>`; everything already on disk is history, so
    // tail from the current end of the transcript.
    const claudeBin = await this.binaryPathResolver()
    const jsonlPath = path.join(projectsDir(), encodeCwd(cwd), `${sessionId}.jsonl`)
    const startOffset = await transcriptSize(jsonlPath)
    const host = this.hostFactory()
    await host.start({
      claudeBin,
      cwd,
      args: buildClaudeArgs(opts),
      env: opts?.env,
      projectsDir: projectsDir(),
      resumeSessionId: sessionId,
    })
    host.sendPrompt(prompt)
    await host.onSession()
    return this.attach({ sessionId, cwd, host, jsonlPath, startOffset })
  }

  stream(handle: SessionHandle): AsyncIterable<EngineEvent> {
    const session = this.sessions.get(handle.sessionId)
    return {
      async *[Symbol.asyncIterator]() {
        if (!session) return
        // Capture the run live at stream() time — the orchestrator
        // calls spawn()/resume() then stream() synchronously.
        const run = session.run
        let idx = 0
        while (true) {
          if (idx < run.queue.length) {
            const ev = run.queue[idx++]
            if (!ev) continue
            yield ev
            if (ev.type === "done" || ev.type === "error") return
            continue
          }
          if (run.closed) return
          await new Promise<void>((resolve) => run.waiters.push(resolve))
        }
      },
    }
  }

  async readHistory(sessionId: string): Promise<EngineHistory> {
    const messages = await readHistoryImpl(sessionId)
    const usageMetrics = deriveSessionUsageMetrics(messages)
    return { messages, ...(usageMetrics ? { usageMetrics } : {}) }
  }

  async deleteHistory(sessionId: string): Promise<void> {
    return deleteHistoryImpl(sessionId)
  }

  async listSessions(cwd: string): Promise<SessionMeta[]> {
    return listSessionsForCwd(cwd)
  }

  async listCommands(opts?: EngineCommandDiscoveryOpts): Promise<readonly EngineCommandEntry[]> {
    return listClaudeCommands(opts?.cwd)
  }

  async stop(handle: SessionHandle): Promise<void> {
    const session = this.sessions.get(handle.sessionId)
    if (!session) return
    session.tail?.stop()
    session.host.stop()
    // Terminate any in-flight stream so the consumer's `for await` ends.
    this.closeRun(session.run, { type: "done" }, /* onlyIfOpen */ true)
    this.sessions.delete(handle.sessionId)
  }

  // --- internals -----------------------------------------------------

  /** Register a session, wire its transcript tail, and arm turn timers. */
  private attach(args: {
    sessionId: string
    cwd: string
    host: InteractiveHost
    jsonlPath: string
    startOffset: number
  }): SessionHandle {
    const session: InteractiveSession = {
      sessionId: args.sessionId,
      cwd: args.cwd,
      host: args.host,
      tail: null,
      run: newRun(),
    }
    this.sessions.set(args.sessionId, session)

    // A host that dies mid-turn must fail the open run, not hang it.
    args.host.on((ev) => {
      if (ev.type === "exit") {
        this.closeRun(session.run, { type: "error", message: "interactive claude session ended" }, true)
      } else if (ev.type === "error") {
        this.closeRun(session.run, { type: "error", message: `interactive claude host: ${ev.message}` }, true)
      }
    })

    session.tail = new TranscriptTail({
      filePath: args.jsonlPath,
      startOffset: args.startOffset,
      onRecord: (record) => this.onRecord(session, record),
    })
    session.tail.start()
    this.armTimers(session.run)
    return { sessionId: args.sessionId, cwd: args.cwd }
  }

  /** Map a transcript record into the current run's event queue. */
  private onRecord(session: InteractiveSession, record: Record<string, unknown>): void {
    const run = session.run
    if (run.closed) return
    const mapped = recordToEvents(record)
    for (const ev of mapped.events) {
      run.queue.push(ev)
      if (ev.type === "assistant.delta" || ev.type === "tool.start" || ev.type === "reasoning.delta") {
        run.sawAssistant = true
      }
    }
    if (mapped.events.length > 0) this.notify(run)

    // Any record activity resets the quiet-period fallback timer.
    this.resetQuietTimer(run)

    // Completion: an assistant record carrying a terminal `stop_reason`.
    // It is NOT closed immediately — claude-code persists one record per
    // content block, so a thinking record and the text record of the
    // same message both carry `end_turn`. Arm a short settle timer that
    // every later record resets; the run closes once it expires.
    // `tool_use` is non-terminal — more records follow.
    if (mapped.role === "assistant" && mapped.stopReason && TERMINAL_STOP_REASONS.has(mapped.stopReason)) {
      this.armSettleTimer(run)
    }
  }

  /** Arm the no-response ceiling for a freshly started turn. */
  private armTimers(run: RunState): void {
    run.hardTimer = setTimeout(() => {
      if (!run.sawAssistant) {
        this.closeRun(run, { type: "error", message: "interactive claude produced no response" }, true)
      }
    }, this.noResponseMs)
    run.hardTimer.unref?.()
  }

  /**
   * (Re)arm the settle timer. Fires `done` once the transcript has been
   * quiet for `settleMs` after a record with a terminal `stop_reason` —
   * collapsing a multi-block assistant message (separate thinking/text
   * records) into a single turn completion.
   */
  private armSettleTimer(run: RunState): void {
    if (run.settleTimer) clearTimeout(run.settleTimer)
    run.settleTimer = setTimeout(() => this.closeRun(run, { type: "done" }, true), this.settleMs)
    run.settleTimer.unref?.()
  }

  /**
   * (Re)arm the quiet-period timer. Fires `done` only once the assistant
   * has produced at least one record and the transcript has then been
   * silent for `quietMs` — the fallback for a transcript that never
   * carries a `stop_reason` at all.
   */
  private resetQuietTimer(run: RunState): void {
    if (run.quietTimer) clearTimeout(run.quietTimer)
    run.quietTimer = setTimeout(() => {
      if (run.sawAssistant) this.closeRun(run, { type: "done" }, true)
    }, this.quietMs)
    run.quietTimer.unref?.()
  }

  /** Push a terminal event, clear timers, and wake any stream consumer. */
  private closeRun(run: RunState, terminal: EngineEvent, onlyIfOpen: boolean): void {
    if (run.closed) {
      if (!onlyIfOpen) run.queue.push(terminal)
      return
    }
    run.closed = true
    if (run.settleTimer) clearTimeout(run.settleTimer)
    if (run.quietTimer) clearTimeout(run.quietTimer)
    if (run.hardTimer) clearTimeout(run.hardTimer)
    run.settleTimer = null
    run.quietTimer = null
    run.hardTimer = null
    run.queue.push(terminal)
    this.notify(run)
  }

  private notify(run: RunState): void {
    const waiters = run.waiters
    run.waiters = []
    for (const w of waiters) w()
  }
}

/**
 * CLI args for the interactive `claude` REPL. Only `--model` is
 * forwarded — the interactive REPL has its own permission UI, and
 * approval/plan flows are out of scope for KOB-208.
 */
function buildClaudeArgs(opts?: SpawnOpts): string[] {
  const args: string[] = []
  if (opts?.model) args.push("--model", opts.model)
  return args
}
