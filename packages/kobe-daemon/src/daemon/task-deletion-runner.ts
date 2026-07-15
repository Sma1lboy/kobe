import type { DaemonOrchestrator, DaemonTask } from "./contracts.ts"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"

export interface TaskDeletionScheduler {
  enqueue(taskId: string): void
}

/** Deduplicated daemon owner for durable background task deletion. */
export class TaskDeletionRunner implements TaskDeletionScheduler {
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(
    private readonly orch: DaemonOrchestrator,
    private readonly runtime: Pick<DaemonRuntimeAdapter, "tearDownTaskSession">,
    private readonly clearActivity: (taskId: string) => void,
  ) {}

  enqueue(taskId: string): void {
    if (this.inFlight.has(taskId)) return
    const pending = Promise.resolve()
      .then(() => this.run(taskId))
      .catch((err) => logDaemonError("task-deletion", err))
      .finally(() => this.inFlight.delete(taskId))
    this.inFlight.set(taskId, pending)
  }

  resume(tasks: readonly DaemonTask[]): void {
    for (const task of tasks) {
      if (task.deletion?.phase === "queued" || task.deletion?.phase === "running") this.enqueue(task.id)
    }
  }

  /** Test seam: resolves when all jobs known at call time have settled. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()])
  }

  private async run(taskId: string): Promise<void> {
    if (!(await this.orch.beginTaskDeletion(taskId))) return
    this.clearActivity(taskId)
    await this.runtime.tearDownTaskSession(taskId).catch((err) => logDaemonError("task-deletion-session-teardown", err))
    await this.orch.finishTaskDeletion(taskId)
  }
}
