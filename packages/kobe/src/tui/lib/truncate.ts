export function truncateEnd(s: string, max: number): string {
  if (max <= 0) return ""
  const points = [...s]
  if (points.length <= max) return s
  return `${points.slice(0, Math.max(0, max - 1)).join("")}…`
}

export function truncateStart(s: string, max: number): string {
  if (max <= 0) return ""
  const points = [...s]
  if (points.length <= max) return s
  return `…${points.slice(points.length - Math.max(0, max - 1)).join("")}`
}
