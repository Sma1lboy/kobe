/**
 * Shared environment policy for read-only git inspection.
 *
 * `git status` and some diff/ref probes may opportunistically refresh index
 * metadata and take `.git/index.lock`. Render paths, daemon collectors, and
 * preview helpers must inspect without competing with engine commits, so they
 * all opt into the same lock-free git environment here.
 */

export const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: "0" } as const

/** Merge the read-only git policy into a process env for direct spawns. */
export function readOnlyGitProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...READ_ONLY_GIT_ENV }
}
