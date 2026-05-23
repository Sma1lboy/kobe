/**
 * Tiny argv parser. kobe-ops only takes long-form `--key value` flags
 * and unknown flags are silently ignored (forward-compat — the kobe
 * shell may grow new flags faster than this binary's package gets
 * republished).
 */

export interface OpsArgs {
  readonly taskId?: string
  readonly worktree?: string
  readonly targetPane?: string
}

export function parseArgv(argv: readonly string[]): OpsArgs {
  let taskId: string | undefined
  let worktree: string | undefined
  let targetPane: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === undefined) continue
    if (value === undefined) continue
    switch (flag) {
      case "--task-id":
        taskId = value
        i++
        break
      case "--worktree":
        worktree = value
        i++
        break
      case "--target-pane":
        targetPane = value
        i++
        break
      default:
        // Forward-compat: ignore unknown flags so a newer kobe shell
        // adding a flag doesn't crash an older kobe-ops install.
        break
    }
  }
  return { taskId, worktree, targetPane }
}
