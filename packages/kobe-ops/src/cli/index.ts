#!/usr/bin/env bun
/**
 * `kobe-ops` CLI entry point (v0.6.0).
 *
 * Argv:
 *   --task-id <id>            stable kobe task id (informational)
 *   --worktree <path>         absolute path to the task's git worktree
 *   --target-pane <selector>  tmux pane selector for future send-keys
 *                             (reserved for 0.6.x; not used yet)
 *
 * Errors loudly on missing required args so a misconfigured tmux
 * `ensureSession` shows up in the Ops pane rather than crashing in
 * the background.
 */
import { parseArgv } from "../lib/argv.ts"
import { runOpsPane } from "../ops/run.tsx"

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2))
  if (!parsed.taskId || !parsed.worktree) {
    process.stderr.write("kobe-ops: --task-id <id> and --worktree <path> are required\n")
    process.exit(2)
  }
  await runOpsPane({
    taskId: parsed.taskId,
    worktree: parsed.worktree,
    targetPane: parsed.targetPane,
  })
}

main().catch((err) => {
  process.stderr.write(`kobe-ops: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
