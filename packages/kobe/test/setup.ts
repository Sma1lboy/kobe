/** Keep unit tests independent from the public CLI that launched the test process. */
export function clearInheritedCliInvocation(env: NodeJS.ProcessEnv = process.env): void {
  Reflect.deleteProperty(env, "ROVE_INVOKED_AS")
}

clearInheritedCliInvocation()
