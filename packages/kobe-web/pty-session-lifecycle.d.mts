import type { Scrollback } from "./pty-scrollback.mjs"

export type PtyMode = "engine" | "shell"

export interface PtyLaunchSpec {
  cwd: string
  command: string[]
}

export interface PtyLike {
  onData(cb: (data: string) => void): void
  onExit(cb: () => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface PtySocketLike {
  OPEN: number
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: "message", cb: (raw: { toString(): string }) => void): void
  on(event: "close", cb: () => void): void
}

export interface PtySessionManagerOptions {
  fetchSpec(taskId: string, mode: PtyMode): Promise<PtyLaunchSpec>
  spawnPty(
    command: string,
    args: string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: NodeJS.ProcessEnv | Record<string, string>
    },
  ): PtyLike
  createScrollback(cap: number): Scrollback
  scrollbackCap: number
  env: NodeJS.ProcessEnv | Record<string, string> | (() => NodeJS.ProcessEnv | Record<string, string>)
  setTimeoutFn?: (cb: () => void, ms: number) => unknown
  submitDelays?: {
    spawnedPasteMs: number
    existingPasteMs: number
    enterMs: number
  }
}

export interface AttachSocketInput {
  ws: PtySocketLike
  tabId: string
  taskId: string
  mode: PtyMode
  cols: number
  rows: number
}

export interface SendTextInput {
  tabId: string
  taskId: string | null
  text: string
}

export interface PtySessionManager {
  attachSocket(input: AttachSocketInput): Promise<unknown>
  closeSession(tabId: string): boolean
  ensureSession(tabId: string, taskId: string, mode: PtyMode, cols: number, rows: number): Promise<unknown>
  sendText(input: SendTextInput): Promise<{ sent: boolean; spawned: boolean; missing?: boolean }>
  shutdown(): void
  sessionCount(): number
  pendingSpawnCount(): number
}

export function createPtySessionManager(options: PtySessionManagerOptions): PtySessionManager
