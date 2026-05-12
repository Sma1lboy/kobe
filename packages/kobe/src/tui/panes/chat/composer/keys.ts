type ComposerKeyLike = {
  readonly name?: string
  readonly shift?: boolean
}

export function isPermissionModeCycleKey(key: ComposerKeyLike): boolean {
  return (key.name === "tab" && key.shift === true) || key.name === "backtab"
}
