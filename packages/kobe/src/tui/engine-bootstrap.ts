/**
 * Engine selection + fake-engine HTTP side-channel.
 *
 * Builds the `AIEngine` the orchestrator drives:
 *   - Default: `ClaudeCodeLocal` (subprocess wrapper around `claude` CLI).
 *   - With `KOBE_TEST_ENGINE=fake`: in-process `FakeAIEngine` plus a tiny
 *     HTTP side-channel on `KOBE_TEST_FAKE_PORT` for behavior tests to
 *     script events. The test pre-allocates the port and POSTs JSON to
 *     `/script` and `/finish` — and also drives `/pr` and `/respond` for
 *     the PR + user-input flows.
 *   - With `KOBE_TEST_ENGINE=dev-fake`: in-process `DevAIEngine`, the
 *     auto-replying fake used by `bun run dev:test`.
 *
 * Production never sets either env var.
 *
 * Extracted from `src/tui/app.tsx` during the Shell refactor. The
 * test-only HTTP side-channel is flagged by the architecture review
 * for a future cleanup, but it's relocated verbatim here so the
 * behaviour is identical.
 */

import { ClaudeCodeLocal } from "../engine/claude-code-local/index.ts"
import type { AIEngine } from "../types/engine.ts"

/**
 * Build the AI engine the orchestrator will drive. Test mode uses
 * `FakeAIEngine` and mounts the side-channel HTTP server.
 */
export async function buildEngine(): Promise<AIEngine> {
  if (process.env.KOBE_TEST_ENGINE === "fake") {
    // Late import — keep test-only deps out of production bundles.
    const { FakeAIEngine } = await import("../../test/behavior/fake-engine.ts")
    const fake = new FakeAIEngine()
    await mountFakeEngineServer(fake)
    return fake
  }
  if (process.env.KOBE_TEST_ENGINE === "dev-fake") {
    // `bun run dev:test` mode — auto-replying fake so the dev TUI
    // exercises the chat round-trip without a real `claude` binary.
    // No HTTP scripter; canned replies live in DevAIEngine itself.
    const { DevAIEngine } = await import("../engine/dev-fake.ts")
    return new DevAIEngine()
  }
  return new ClaudeCodeLocal()
}

/**
 * Tiny HTTP side-channel for the G2 behavior test. The test pre-allocates
 * a port (via `KOBE_TEST_FAKE_PORT`) and POSTs scripted events to it.
 * Kobe runs in a child process so we can't share the FakeAIEngine
 * instance via memory; HTTP is the simplest cross-process scripting
 * mechanism that works under Bun + macOS without extra deps.
 */
async function mountFakeEngineServer(fake: import("../../test/behavior/fake-engine.ts").FakeAIEngine): Promise<void> {
  const portStr = process.env.KOBE_TEST_FAKE_PORT
  if (!portStr) return
  const port = Number(portStr)
  if (!Number.isFinite(port)) return

  const { createServer } = await import("node:http")
  const server = createServer((req, res) => {
    if (req.method !== "POST" && req.method !== "GET") {
      res.writeHead(405).end()
      return
    }
    let body = ""
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8")
    })
    req.on("end", () => {
      try {
        if (req.url === "/script" && req.method === "POST") {
          const { sessionId, events } = JSON.parse(body) as { sessionId: string; events: unknown[] }
          fake.script(sessionId, events as Parameters<typeof fake.script>[1])
          res.writeHead(200, { "content-type": "application/json" })
          res.end("{}")
          return
        }
        if (req.url === "/finish" && req.method === "POST") {
          const { sessionId } = JSON.parse(body) as { sessionId: string }
          fake.finish(sessionId)
          res.writeHead(200, { "content-type": "application/json" })
          res.end("{}")
          return
        }
        // Test affordance for W4.PR: trigger requestPR on the active
        // task. The Shell mounts a global function that knows the
        // active task; we call it from here. Returns 503 if the Shell
        // hasn't mounted yet (pre-render race window).
        if (req.url === "/pr" && req.method === "POST") {
          type PRTrigger = () => Promise<{ taskId: string; prompt: string }>
          const trigger = (globalThis as { __kobeTestRequestPR?: PRTrigger }).__kobeTestRequestPR
          if (!trigger) {
            res.writeHead(503, { "content-type": "text/plain" })
            res.end("__kobeTestRequestPR not yet available")
            return
          }
          trigger()
            .then((info) => {
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify(info))
            })
            .catch((err: unknown) => {
              res.writeHead(500, { "content-type": "text/plain" })
              res.end(err instanceof Error ? err.message : String(err))
            })
          return
        }
        // Test affordance for the user-input pause flows. Mirrors
        // /pr above: the Shell mounts __kobeTestRespondToInput which
        // knows the active task + its current pending-input bucket.
        // The test POSTs the body of an ApprovePlanResponse or
        // AskQuestionResponse and we route it through respondToInput
        // for the latest pending request. Returns 503 pre-mount, 409
        // when there's no pending request yet (the test should wait
        // for the picker to render), 200 with the resolved requestId
        // on success.
        if (req.url === "/respond" && req.method === "POST") {
          type RespondTrigger = (
            response: import("../types/engine.ts").UserInputResponse,
          ) => Promise<{ taskId: string; requestId: string; prompt: string }>
          const trigger = (globalThis as { __kobeTestRespondToInput?: RespondTrigger }).__kobeTestRespondToInput
          if (!trigger) {
            res.writeHead(503, { "content-type": "text/plain" })
            res.end("__kobeTestRespondToInput not yet available")
            return
          }
          let parsed: import("../types/engine.ts").UserInputResponse
          try {
            parsed = JSON.parse(body) as import("../types/engine.ts").UserInputResponse
          } catch (err) {
            res.writeHead(400, { "content-type": "text/plain" })
            res.end(`bad JSON: ${(err as Error).message}`)
            return
          }
          trigger(parsed)
            .then((info) => {
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify(info))
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err)
              // No-pending-request is a 409 so the test can distinguish
              // "you raced" from "the engine actually failed."
              const code = msg.includes("no pending input") ? 409 : 500
              res.writeHead(code, { "content-type": "text/plain" })
              res.end(msg)
            })
          return
        }
        res.writeHead(404).end()
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" })
        res.end((err as Error).message)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()))
  // Don't keep the event loop alive on this server alone.
  server.unref()
}
