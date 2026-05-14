type ComposerKeyLike = {
  readonly name?: string
  readonly sequence?: string
  readonly shift?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly super?: boolean
}

export function isPermissionModeCycleKey(key: ComposerKeyLike): boolean {
  return (key.name === "tab" && key.shift === true) || key.name === "backtab"
}

export function isPlainAutocompleteTabKey(key: ComposerKeyLike): boolean {
  return (key.name === "tab" || key.sequence === "\t") && !key.shift && !key.ctrl && !key.meta && !key.super
}
