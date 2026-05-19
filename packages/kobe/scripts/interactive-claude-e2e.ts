/**
 * End-to-end smoke for the KOB-208 interactive-claude engine.
 *
 * Drives `InteractiveClaudeEngine` directly — no orchestrator, no TUI,
 * no `~/.kobe` state — so it is safe to run without polluting
 * production state. It proves the core pipeline:
 *
 *     spawn → hidden PTY hosts interactive `claude`
 *           → prompt injected into the REPL's stdin
 *           → transcript JSONL tailed + parsed
 *           → assistant reply surfaces as EngineEvents
 *
 * Usage:
 *   bun run scripts/interactive-claude-e2e.ts [--cwd <dir>] [--prompt <text>]
 *
 * Preconditions (out-of-scope to automate for KOB-208):
 *   - A real `claude` binary on PATH, logged in.
 *   - `--cwd` must be a directory `claude` already trusts. The interactive
 *     REPL shows a "trust this folder?" dialog for an unknown directory,
 *     and that dialog is a stateful PTY-only surface this engine does not
 *     drive (see the engine's "known limitations"). Run `claude` once in
 *     the directory by hand first if unsure.
 */

import { InteractiveClaudeEngine } from "../src/engine/interactive-claude/index.ts"

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback
}

const cwd = arg("cwd", process.cwd())
const prompt = arg("prompt", "Reply with exactly the single word PONG and nothing else.")

async function main(): Promise<void> {
  console.log(`[e2e] cwd:    ${cwd}`)
  console.log(`[e2e] prompt: ${prompt}`)
  console.log("[e2e] spawning interactive claude (this takes ~5-10s for the REPL to draw)...")

  const engine = new InteractiveClaudeEngine()
  const handle = await engine.spawn(cwd, prompt)
  console.log(`[e2e] session: ${handle.sessionId}`)

  let assistantText = ""
  let toolCalls = 0
  const overall = setTimeout(() => {
    console.error("[e2e] FAIL — overall timeout (no terminal event in 180s)")
    process.exit(1)
  }, 180_000)

  for await (const ev of engine.stream(handle)) {
    switch (ev.type) {
      case "assistant.delta":
        assistantText += ev.text
        console.log(`[e2e] assistant.delta: ${JSON.stringify(ev.text)}`)
        break
      case "reasoning.delta":
        console.log(`[e2e] reasoning.delta: ${ev.text.length} chars`)
        break
      case "tool.start":
        toolCalls++
        console.log(`[e2e] tool.start: ${ev.name}`)
        break
      case "tool.result":
        console.log(`[e2e] tool.result: ${ev.name}`)
        break
      case "usage":
        console.log(`[e2e] usage: in=${ev.input_tokens} out=${ev.output_tokens}`)
        break
      case "done":
        console.log("[e2e] done")
        break
      case "error":
        console.error(`[e2e] error: ${ev.message}`)
        break
    }
  }
  clearTimeout(overall)

  await engine.stop(handle)
  console.log("[e2e] stopped host")

  if (assistantText.trim().length > 0) {
    console.log(`\n[e2e] PASS — assistant replied (${assistantText.trim().length} chars, ${toolCalls} tool calls)`)
    process.exit(0)
  }
  console.error("\n[e2e] FAIL — no assistant text was rendered")
  process.exit(1)
}

main().catch((err) => {
  console.error(`[e2e] FAIL — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
})
