/**
 * Which interactive engine CLI to launch in a task's tmux pane (KOB-233).
 *
 * The "middle" pane of a task session runs a vendor's *interactive* CLI
 * (the same binary a human would run in a terminal) — not the headless
 * path. This is the single place that maps a task's `vendor` to that
 * argv, so wiring a new engine (gemini, copilot, …) is a one-line case
 * here plus its history reader; every launch site (the outer monitor's
 * Handover, the Tasks-pane switch, `new-chattab`) goes through this.
 *
 * Codex's bare `codex` (no subcommand) opens its interactive TUI, the
 * same way bare `claude` does — `codex exec` is the headless path we
 * deliberately don't use here.
 */

import type { VendorId } from "@/types/task"

export function interactiveEngineCommand(vendor: VendorId | undefined): readonly string[] {
  switch (vendor) {
    case "codex":
      return ["codex"]
    default:
      return ["claude"]
  }
}
