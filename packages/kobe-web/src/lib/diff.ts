import { api } from "./api-client.ts"

export interface DiffFile {
  path: string
  status: string
  staged: boolean
  patch: string
}

export interface DiffResult {
  files: DiffFile[]
}

export interface FetchDiffOptions {
  path?: string
  namesOnly?: boolean
}

export async function fetchDiff(
  worktreePath: string,
  opts: FetchDiffOptions = {},
): Promise<DiffResult> {
  const json = await api.get<Partial<DiffResult>>("/api/diff", {
    query: {
      worktreePath,
      path: opts.path,
      namesOnly: opts.namesOnly ? "1" : undefined,
    },
    label: "diff fetch",
  })
  return { files: json.files ?? [] }
}
