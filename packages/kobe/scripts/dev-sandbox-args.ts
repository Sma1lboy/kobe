export type SandboxMode = "run" | "reset" | "home"
export type SandboxArgs = { mode: SandboxMode }

function isSandboxMode(value: string | undefined): value is SandboxMode {
  return value === "run" || value === "reset" || value === "home"
}

export function parseSandboxArgs(args: readonly string[]): SandboxArgs {
  const first = args[0]
  if (first !== undefined && !isSandboxMode(first)) throw new Error(`unknown sandbox mode "${first}"`)
  if (args.length > 1) throw new Error(`unexpected argument "${args[1]}"`)
  return { mode: first ?? "run" }
}
