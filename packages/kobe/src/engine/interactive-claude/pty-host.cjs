/**
 * Interactive-claude PTY host — a standalone Node.js process.
 *
 * Part of KOB-208. kobe's daemon runs under Bun, but the spike found
 * that `node-pty`'s `data` callback never fires under Bun 1.3.11, so
 * the hidden PTY that drives an *interactive* `claude` REPL must live
 * in a real Node child. This file is that child.
 *
 * It is intentionally a `.cjs` so Node runs it with zero transpile and
 * `require("node-pty")` resolves the native module directly. kobe never
 * imports this file — it spawns it (see `host-client.ts`).
 *
 * --- IPC ---
 * Two unidirectional JSON-line channels:
 *   - parent → host : commands on this process's STDIN, one JSON per line.
 *   - host → parent : events on this process's STDOUT, one JSON per line.
 * Raw PTY bytes (terminal escape sequences) are consumed internally and
 * never written to stdout — that would corrupt the line protocol. Human
 * log lines go to STDERR.
 *
 * Commands (parent → host):
 *   { type: "start", claudeBin, cwd, args?, env?, projectsDir,
 *     resumeSessionId?, readyDelayMs?, cols?, rows? }
 *   { type: "prompt", text }
 *   { type: "stop" }
 *
 * Events (host → parent):
 *   { type: "ready" }                              host process is up
 *   { type: "spawned", pid }                       claude PTY forked
 *   { type: "session", sessionId, jsonlPath }      transcript file known
 *   { type: "alive", pid }                         heartbeat
 *   { type: "exit", code, signal }                 claude PTY exited
 *   { type: "error", message }                     fatal host error
 *
 * --- sessionId detection ---
 * Interactive `claude` writes its transcript to
 *   <projectsDir>/<encoded-cwd>/<sessionId>.jsonl
 * For a fresh session the host snapshots the directory at spawn time,
 * then watches for a `.jsonl` file that was not in the snapshot. For a
 * resume, the sessionId is already known and is reported immediately.
 */

"use strict"

const fs = require("node:fs")
const path = require("node:path")

/** Encode a cwd to Claude Code's on-disk project dir name (mirrors history.ts `encodeCwd`). */
function encodeCwd(cwd) {
  return cwd.replace(/[/.]/g, "-")
}

function send(event) {
  try {
    process.stdout.write(`${JSON.stringify(event)}\n`)
  } catch {
    /* parent pipe gone — nothing we can do */
  }
}

function log(message) {
  try {
    process.stderr.write(`[pty-host] ${message}\n`)
  } catch {
    /* ignore */
  }
}

let pty
try {
  pty = require("node-pty")
} catch (err) {
  send({ type: "error", message: `failed to load node-pty: ${err?.message ? err.message : String(err)}` })
  process.exit(1)
}

/** @type {import("node-pty").IPty | null} */
let term = null
let ready = false
/** Prompts received before the REPL finished drawing its input box. */
const pendingPrompts = []
let sessionReported = false
let stopping = false
let heartbeat = null

/**
 * Watch the encoded-cwd project directory for the freshly created
 * `<sessionId>.jsonl` and report it once. `knownBefore` is the set of
 * `.jsonl` names that existed before spawn — anything new is ours.
 */
function detectSession(projectsDir, cwd) {
  const dir = path.join(projectsDir, encodeCwd(cwd))
  const knownBefore = new Set()
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".jsonl")) knownBefore.add(name)
    }
  } catch {
    /* dir not created yet — fine, we poll for it below */
  }

  const report = () => {
    if (sessionReported) return true
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return false
    }
    // Newest first so a rapid double-create still picks the latest.
    const fresh = names
      .filter((n) => n.endsWith(".jsonl") && !knownBefore.has(n))
      .map((n) => {
        const full = path.join(dir, n)
        let mtime = 0
        try {
          mtime = fs.statSync(full).mtimeMs
        } catch {
          /* race: file vanished */
        }
        return { n, full, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
    const pick = fresh[0]
    if (!pick) return false
    sessionReported = true
    send({
      type: "session",
      sessionId: pick.n.replace(/\.jsonl$/, ""),
      jsonlPath: pick.full,
    })
    return true
  }

  if (report()) return
  // Poll: fs.watch on a not-yet-existent dir is unreliable across
  // platforms, and the transcript file lands within a few seconds of
  // the first prompt. A 250ms poll for up to 90s is simple and robust.
  const started = Date.now()
  const timer = setInterval(() => {
    if (sessionReported || stopping) {
      clearInterval(timer)
      return
    }
    if (report() || Date.now() - started > 90_000) {
      clearInterval(timer)
    }
  }, 250)
  timer.unref?.()
}

/** Inject a prompt into the REPL: bracketed paste, then a carriage return. */
function injectPrompt(text) {
  if (!term) return
  // Bracketed paste keeps multi-line prompts from being submitted line
  // by line — the REPL treats the whole block as a single paste.
  term.write(`\x1b[200~${text}\x1b[201~`)
  // The spike found ~200ms between the paste and the submit is reliable;
  // the REPL needs a tick to register the pasted block before Enter.
  setTimeout(() => {
    if (term) term.write("\r")
  }, 200)
}

function flushPrompts() {
  while (pendingPrompts.length > 0) {
    const next = pendingPrompts.shift()
    injectPrompt(next)
  }
}

function handleStart(cmd) {
  if (term) {
    log("ignoring duplicate start command")
    return
  }
  const claudeBin = cmd.claudeBin
  const cwd = cmd.cwd
  if (!claudeBin || !cwd) {
    send({ type: "error", message: "start command missing claudeBin or cwd" })
    return
  }
  const args = Array.isArray(cmd.args) ? cmd.args.slice() : []
  if (cmd.resumeSessionId) args.push("--resume", cmd.resumeSessionId)

  const env = { ...process.env, ...(cmd.env || {}) }
  // A real terminal type so the REPL draws its full input UI.
  env.TERM = env.TERM || "xterm-256color"

  try {
    term = pty.spawn(claudeBin, args, {
      name: "xterm-256color",
      cols: typeof cmd.cols === "number" ? cmd.cols : 120,
      rows: typeof cmd.rows === "number" ? cmd.rows : 40,
      cwd,
      env,
    })
  } catch (err) {
    send({ type: "error", message: `failed to spawn claude PTY: ${err?.message ? err.message : String(err)}` })
    return
  }

  send({ type: "spawned", pid: term.pid })
  log(`spawned claude pid=${term.pid} cwd=${cwd}`)

  // Drain PTY output. The bytes are terminal escape sequences we never
  // parse (the transcript JSONL is the source of truth) — but the
  // callback MUST be attached or the PTY stalls on a full buffer.
  const debug = !!process.env.KOBE_PTY_DEBUG
  term.onData((data) => {
    if (debug) process.stderr.write(data)
  })

  term.onExit(({ exitCode, signal }) => {
    send({ type: "exit", code: exitCode ?? 0, signal: signal ?? 0 })
    log(`claude PTY exited code=${exitCode} signal=${signal}`)
    term = null
    if (heartbeat) clearInterval(heartbeat)
    process.exit(0)
  })

  // Resume reuses the existing transcript; the id is already known.
  // Fresh sessions need the on-disk detection scan.
  if (cmd.resumeSessionId && cmd.projectsDir) {
    sessionReported = true
    send({
      type: "session",
      sessionId: cmd.resumeSessionId,
      jsonlPath: path.join(cmd.projectsDir, encodeCwd(cwd), `${cmd.resumeSessionId}.jsonl`),
    })
  } else if (cmd.projectsDir) {
    detectSession(cmd.projectsDir, cwd)
  }

  // The REPL needs a few seconds to draw its input box before stdin
  // injection lands reliably (spike: 3-4s). Queue prompts until then.
  const readyDelayMs = typeof cmd.readyDelayMs === "number" ? cmd.readyDelayMs : 4000
  setTimeout(() => {
    ready = true
    log(`REPL ready after ${readyDelayMs}ms`)
    flushPrompts()
  }, readyDelayMs)

  // Heartbeat so the parent can tell the host apart from a hung pipe.
  heartbeat = setInterval(() => {
    if (term) send({ type: "alive", pid: term.pid })
  }, 5000)
  heartbeat.unref?.()
}

function handlePrompt(cmd) {
  const text = typeof cmd.text === "string" ? cmd.text : ""
  if (!text) return
  if (!term) {
    send({ type: "error", message: "prompt received before start" })
    return
  }
  if (!ready) {
    pendingPrompts.push(text)
    return
  }
  injectPrompt(text)
}

function handleStop() {
  stopping = true
  if (heartbeat) clearInterval(heartbeat)
  if (term) {
    try {
      term.kill()
    } catch {
      /* already dead */
    }
  }
  // Give onExit a moment to fire; force-exit if it doesn't.
  setTimeout(() => process.exit(0), 1000).unref?.()
}

function dispatch(line) {
  const trimmed = line.trim()
  if (!trimmed) return
  let cmd
  try {
    cmd = JSON.parse(trimmed)
  } catch (err) {
    log(`bad command JSON: ${err?.message ? err.message : String(err)}`)
    return
  }
  if (!cmd || typeof cmd.type !== "string") return
  switch (cmd.type) {
    case "start":
      handleStart(cmd)
      break
    case "prompt":
      handlePrompt(cmd)
      break
    case "stop":
      handleStop()
      break
    default:
      log(`unknown command type: ${cmd.type}`)
  }
}

// Read newline-delimited commands off stdin.
let stdinBuf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk
  let nl = stdinBuf.indexOf("\n")
  while (nl !== -1) {
    const line = stdinBuf.slice(0, nl)
    stdinBuf = stdinBuf.slice(nl + 1)
    dispatch(line)
    nl = stdinBuf.indexOf("\n")
  }
})
process.stdin.on("end", () => {
  // Parent closed the command channel — shut the PTY down with it.
  handleStop()
})

process.on("uncaughtException", (err) => {
  send({ type: "error", message: `uncaught: ${err?.message ? err.message : String(err)}` })
})
process.on("unhandledRejection", (reason) => {
  send({ type: "error", message: `unhandled rejection: ${reason?.message ? reason.message : String(reason)}` })
})

send({ type: "ready" })
log("host process started")
