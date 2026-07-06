import { type TaskPty, type TaskPtyOpts, createTaskPty } from "./pty"

export type AcquireOpts = Omit<TaskPtyOpts, "taskId" | "cwd">

export type PtyFactory = (opts: TaskPtyOpts) => TaskPty

export class PtyRegistry {
  private readonly map = new Map<string, TaskPty>()
  private readonly factory: PtyFactory

  constructor(factory: PtyFactory = createTaskPty) {
    this.factory = factory
  }

  acquire(taskId: string, cwd: string, opts: AcquireOpts = {}): TaskPty {
    const existing = this.map.get(taskId)
    if (existing && !existing.killed) return existing
    if (existing) this.map.delete(taskId)

    const pty = this.factory({ taskId, cwd, ...opts })
    this.map.set(taskId, pty)
    return pty
  }

  get(taskId: string): TaskPty | null {
    const pty = this.map.get(taskId)
    if (!pty) return null
    if (pty.killed) {
      this.map.delete(taskId)
      return null
    }
    return pty
  }

  has(taskId: string): boolean {
    return this.get(taskId) !== null
  }

  release(taskId: string): void {
    const pty = this.map.get(taskId)
    this.map.delete(taskId)
    if (!pty) return
    try {
      pty.kill()
    } catch {}
  }

  releaseWhere(predicate: (id: string) => boolean): void {
    const ids = Array.from(this.map.keys()).filter(predicate)
    for (const id of ids) this.release(id)
  }

  releaseAll(): void {
    const ids = Array.from(this.map.keys())
    for (const id of ids) this.release(id)
  }

  reset(taskId: string, cwd: string, opts: AcquireOpts = {}): TaskPty {
    this.release(taskId)
    return this.acquire(taskId, cwd, opts)
  }

  get size(): number {
    return this.map.size
  }
}

let defaultRegistry: PtyRegistry | null = null

export function getDefaultPtyRegistry(): PtyRegistry {
  if (!defaultRegistry) defaultRegistry = new PtyRegistry()
  return defaultRegistry
}

export function _resetDefaultPtyRegistry(): void {
  if (defaultRegistry) defaultRegistry.releaseAll()
  defaultRegistry = null
}
