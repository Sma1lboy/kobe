import { truncateEnd } from "../../lib/truncate"

export function truncateTitle(title: string, max: number): string {
  return truncateEnd(title, max)
}

export function spacedTitle(title: string, max: number): string {
  return ` ${truncateTitle(title, Math.max(0, max))}`
}
