export const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: "0" } as const

export function readOnlyGitProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...READ_ONLY_GIT_ENV }
}
