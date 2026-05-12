/**
 * Claude plan utilization — the data exposed by claude-code's `/usage` slash
 * command and surfaced in kobe's WORKSPACE topbar.
 *
 * Source: `GET https://api.anthropic.com/api/oauth/usage` (see
 * `refs/claude-code/src/services/api/usage.ts`). Read-only — kobe never
 * refreshes the underlying OAuth token, so an expired token surfaces as a
 * null snapshot and the topbar quietly hides the chip until the user runs
 * `claude` again.
 */

export interface PlanRateLimit {
  /** 0-100 percentage. `null` when the API didn't supply a number for this bucket. */
  readonly utilization: number | null
  /** ISO-8601 reset timestamp. `null` when missing or already reset. */
  readonly resetsAt: string | null
}

export interface PlanUsage {
  /** Current rolling 5-hour session bucket. */
  readonly fiveHour: PlanRateLimit | null
  /** Current 7-day plan bucket (all models). */
  readonly sevenDay: PlanRateLimit | null
  readonly sevenDayOpus: PlanRateLimit | null
  readonly sevenDaySonnet: PlanRateLimit | null
  /** When kobe last successfully fetched this snapshot. */
  readonly fetchedAt: string
}
