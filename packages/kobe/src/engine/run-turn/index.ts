import type { VendorId } from "../../types/vendor.ts"
import {
  type CodexRunTurnOptions,
  type CodexRunTurnResult,
  type RunTurnPurpose,
  runCodexHeadlessTurn,
} from "./codex.ts"

export interface RunTurnOptions extends Omit<CodexRunTurnOptions, "purpose"> {
  readonly vendor?: VendorId
  readonly purpose?: RunTurnPurpose
}

export type RunTurnResult = CodexRunTurnResult

export class UnsupportedRunTurnVendorError extends Error {
  constructor(readonly vendor: VendorId) {
    super(`headless runTurn is not wired for engine "${vendor}" yet`)
  }
}

export function supportsHeadlessRunTurn(vendor: VendorId | undefined): boolean {
  return (vendor ?? "codex") === "codex"
}

export async function runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
  const vendor = options.vendor ?? "codex"
  if (vendor !== "codex") throw new UnsupportedRunTurnVendorError(vendor)
  return runCodexHeadlessTurn(options)
}

export async function runSmallModelTurn(options: Omit<RunTurnOptions, "purpose">): Promise<RunTurnResult> {
  return runTurn({ ...options, purpose: "small" })
}
