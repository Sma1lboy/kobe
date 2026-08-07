/**
 * ACP session manager (EXPERIMENTAL vendor `claude-acp`) — the structured
 * sibling of the PTY path. One `@zed-industries/claude-code-acp` subprocess
 * per tab, speaking JSON-RPC 2.0 over newline-delimited stdio; the browser
 * attaches over WS and receives the raw `session/update` stream (plus a
 * replay ring on reattach), so all folding/rendering stays client-side.
 *
 * Deliberately daemon-free: this is a parallel experiment next to the
 * screen-grammar link, not a replacement for it.
 */

import { spawn } from "node:child_process"

const RING_CAP = 2000

function cleanEnv() {
  const env = { ...process.env }
  // Claude Code refuses to nest inside another session (dev shells carry
  // these); the ACP child is its own session.
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}

class AcpSession {
  constructor(tabId, cwd) {
    this.tabId = tabId
    this.cwd = cwd
    this.child = null
    this.nextId = 0
    this.pending = new Map() // rpc id → {resolve, reject}
    this.buf = ""
    this.ring = [] // browser-bound messages, replayed on attach
    this.sockets = new Set()
    this.sessionId = null
    this.dead = false
  }

  start() {
    this.child = spawn("bunx", ["@zed-industries/claude-code-acp"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: cleanEnv(),
    })
    this.child.stdout.on("data", (d) => this.onData(d))
    this.child.stderr.on("data", (d) => {
      this.push({ type: "stderr", text: d.toString().slice(0, 2000) })
    })
    this.child.on("exit", (code) => {
      this.dead = true
      this.push({ type: "exit", code })
    })
    void this.handshake()
  }

  async handshake() {
    try {
      const init = await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      const sess = await this.request("session/new", { cwd: this.cwd, mcpServers: [] })
      this.sessionId = sess.sessionId
      this.push({
        type: "ready",
        sessionId: sess.sessionId,
        models: sess.models ?? null,
        agent: init.agentInfo ?? null,
      })
    } catch (err) {
      this.push({ type: "error", message: err?.message ?? String(err) })
    }
  }

  onData(d) {
    this.buf += d.toString()
    let nl = this.buf.indexOf("\n")
    while (nl >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      nl = this.buf.indexOf("\n")
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      this.onMessage(msg)
    }
  }

  onMessage(msg) {
    // Response to one of our requests.
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? "acp error"))
      else p.resolve(msg.result)
      return
    }
    // Agent → client REQUEST (permissions). Forward; the browser answers.
    if (msg.id !== undefined && msg.method === "session/request_permission") {
      this.push({ type: "permission_request", rpcId: msg.id, params: msg.params })
      return
    }
    if (msg.id !== undefined) {
      // Unsupported agent request (fs/* was declared off) — refuse cleanly.
      this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported" } })
      return
    }
    if (msg.method === "session/update") {
      this.push({ type: "update", update: msg.params?.update, at: Date.now() })
    }
  }

  write(obj) {
    if (this.dead) return
    this.child?.stdin?.write(`${JSON.stringify(obj)}\n`)
  }

  request(method, params) {
    const id = ++this.nextId
    this.write({ jsonrpc: "2.0", id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  /** Browser-bound message: ring + fanout. */
  push(msg) {
    this.ring.push(msg)
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP)
    const text = JSON.stringify(msg)
    for (const ws of this.sockets) {
      try {
        ws.send(text)
      } catch {
        /* socket gone; cleanup on close */
      }
    }
  }

  prompt(text) {
    if (!this.sessionId) return
    // Echo into the ring so reattach replays the user's own turns too.
    this.push({
      type: "update",
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
      at: Date.now(),
    })
    this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    })
      .then((res) => this.push({ type: "turn_end", stopReason: res?.stopReason ?? "end_turn" }))
      .catch((err) => this.push({ type: "error", message: err?.message ?? String(err) }))
  }

  cancel() {
    if (!this.sessionId) return
    this.write({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: this.sessionId },
    })
  }

  permissionOutcome(rpcId, optionId) {
    this.write({
      jsonrpc: "2.0",
      id: rpcId,
      result: { outcome: { outcome: "selected", optionId } },
    })
  }

  attach(ws) {
    this.sockets.add(ws)
    for (const msg of this.ring) {
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        break
      }
    }
  }

  detach(ws) {
    this.sockets.delete(ws)
  }

  close() {
    this.dead = true
    try {
      this.child?.kill()
    } catch {
      /* already gone */
    }
    for (const ws of this.sockets) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear()
  }
}

/** @param {{ fetchCwd: (taskId: string) => Promise<string> }} deps */
export function createAcpManager(deps) {
  const sessions = new Map() // tabId → AcpSession

  return {
    async attach(ws, tabId, taskId) {
      let session = sessions.get(tabId)
      if (!session) {
        const cwd = await deps.fetchCwd(taskId)
        session = new AcpSession(tabId, cwd)
        sessions.set(tabId, session)
        session.start()
      }
      session.attach(ws)
      ws.on("message", (raw) => {
        let msg
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (msg.type === "prompt" && typeof msg.text === "string") session.prompt(msg.text)
        else if (msg.type === "cancel") session.cancel()
        else if (msg.type === "permission_outcome") session.permissionOutcome(msg.rpcId, msg.optionId)
      })
      ws.on("close", () => session.detach(ws))
    },
    close(tabId) {
      const session = sessions.get(tabId)
      if (!session) return false
      sessions.delete(tabId)
      session.close()
      return true
    },
  }
}
