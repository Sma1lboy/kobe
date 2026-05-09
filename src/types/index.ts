/**
 * Barrel export for kobe's core type contracts.
 *
 * Downstream streams (Wave 1: A engine, B worktree, C task index;
 * Wave 2: E orchestrator) import everything they need from this module
 * via the `@types/*` path alias, e.g.:
 *
 *   import type { AIEngine, EngineEvent, Task, TaskStatus } from "@types/index"
 *
 * Adding a new type? Re-export it here. Keep the surface flat — no
 * sub-namespaces unless we hit a real collision.
 */

export type { AIEngine, EngineEvent, Message, SessionHandle, SpawnOpts } from "./engine.ts"
export type { Task, TaskId, TaskIndex, TaskStatus } from "./task.ts"
export { toTaskId } from "./task.ts"
export type { WorktreeInfo, WorktreeManager } from "./worktree.ts"
