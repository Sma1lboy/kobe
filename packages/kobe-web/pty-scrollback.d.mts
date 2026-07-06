export interface Scrollback {
  push(data: string): void
  replay(): string
  length(): number
  chunkCount(): number
}

export function createScrollback(cap: number): Scrollback
