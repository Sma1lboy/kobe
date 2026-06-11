/**
 * Compact relative-time formatting for the task rail ("3m", "2h", "5d").
 * Pure + dependency-free; the rail re-renders on every snapshot so a coarse
 * bucket is plenty (no per-second ticking).
 */

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ""
  const sec = Math.max(0, Math.round((now - then) / 1000))
  if (sec < 45) return "now"
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d`
  const wk = Math.round(day / 7)
  if (wk < 5) return `${wk}w`
  const mo = Math.round(day / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.round(day / 365)}y`
}
