export type WorkspaceTabKind =
  | "empty"
  | "vendor"
  | "terminal"
  | "transcript"
  | "file"

type TitleMode = "count" | "static"

interface TabKindSpec {
  readonly hasPty: boolean
  readonly titleMode: TitleMode
  readonly label: string
}

export const TAB_KINDS: Record<WorkspaceTabKind, TabKindSpec> = {
  empty: { hasPty: false, titleMode: "static", label: "New tab" },
  vendor: { hasPty: true, titleMode: "count", label: "Vendor" },
  terminal: { hasPty: true, titleMode: "count", label: "Terminal" },
  transcript: { hasPty: false, titleMode: "static", label: "Chat" },
  file: { hasPty: false, titleMode: "static", label: "File" },
}

export function tabHasPty(kind: WorkspaceTabKind): boolean {
  return TAB_KINDS[kind].hasPty
}

export function nextTabTitle(
  kind: WorkspaceTabKind,
  existing: readonly { kind: WorkspaceTabKind }[],
): string {
  const spec = TAB_KINDS[kind]
  if (spec.titleMode === "count") {
    const n = existing.filter((tab) => tab.kind === kind).length + 1
    return `${spec.label} ${n}`
  }
  return spec.label
}
