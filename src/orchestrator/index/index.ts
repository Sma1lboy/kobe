/**
 * Barrel for the orchestrator's task-index module.
 *
 * Consumers (Wave 2 Stream E and beyond) should import from here so the
 * internal layout (`store.ts`, `lockfile.ts`, `ulid.ts`) can be
 * refactored without rippling through the codebase.
 */

export { TaskIndexStore, type TaskCreateInput, type TaskIndexStoreOptions } from "./store.ts"
export { acquire, release, isProcessAlive, LockfileError, type LockfileOptions } from "./lockfile.ts"
export { ulid, ULID_ALPHABET } from "./ulid.ts"
