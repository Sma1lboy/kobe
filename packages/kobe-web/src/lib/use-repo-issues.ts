import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fetchIssues, type RepoIssues } from "./issues.ts"
import { normalizeRepoPath } from "./repo-key.ts"
import { useAppState } from "./store.ts"

export interface RepoIssuesResult {
  readonly data: Record<string, RepoIssues>
  readonly failed: Record<string, string>
  readonly loading: boolean
  readonly pending: boolean
  readonly refresh: (roots: readonly string[]) => void
}

export function useRepoIssues(repos: readonly string[]): RepoIssuesResult {
  const { issueSnapshots } = useAppState()
  const [data, setData] = useState<Record<string, RepoIssues>>({})
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  const seqRef = useRef(new Map<string, number>())
  const appliedSeqRef = useRef(new Map<string, number>())
  const lastPushedRef = useRef(new Map<string, RepoIssues>())
  const canonicalRef = useRef(new Map<string, string>())

  const beginRequest = useCallback((root: string): number => {
    const seq = (seqRef.current.get(root) ?? 0) + 1
    seqRef.current.set(root, seq)
    return seq
  }, [])

  const applyState = useCallback(
    (state: RepoIssues, seq: number, cacheKey = state.repoRoot): void => {
      if (seq < (appliedSeqRef.current.get(cacheKey) ?? 0)) return
      appliedSeqRef.current.set(cacheKey, seq)
      if (state.repoRoot && state.repoRoot !== cacheKey) {
        canonicalRef.current.set(cacheKey, state.repoRoot)
      }
      setData((prev) => ({
        ...prev,
        [cacheKey]: { ...state, repoRoot: cacheKey },
      }))
      setFailed((prev) => {
        if (!(cacheKey in prev)) return prev
        const { [cacheKey]: _gone, ...rest } = prev
        return rest
      })
    },
    [],
  )

  const refresh = useCallback(
    (roots: readonly string[]): void => {
      if (roots.length === 0) return
      setLoading(true)
      void Promise.all(
        roots.map(async (root) => {
          const seq = beginRequest(root)
          try {
            applyState(await fetchIssues(root), seq, root)
          } catch (err) {
            setFailed((prev) => ({
              ...prev,
              [root]: err instanceof Error ? err.message : String(err),
            }))
          }
        }),
      ).finally(() => setLoading(false))
    },
    [beginRequest, applyState],
  )

  const repoKey = useMemo(() => [...repos].join("\n"), [repos])
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoKey is the membership fingerprint; refresh is stable. Refetching on every `repos` identity would hammer the bridge.
  useEffect(() => {
    refresh(repoKey ? repoKey.split("\n") : [])
  }, [repoKey])

  useEffect(() => {
    const byNormalized = new Map(
      Object.values(issueSnapshots).map((state) => [
        normalizeRepoPath(state.repoRoot),
        state,
      ]),
    )
    for (const repo of repoKey ? repoKey.split("\n") : []) {
      const canonical = canonicalRef.current.get(repo)
      const pushed =
        byNormalized.get(normalizeRepoPath(repo)) ??
        (canonical ? byNormalized.get(normalizeRepoPath(canonical)) : undefined)
      if (!pushed) continue
      if (lastPushedRef.current.get(repo) === pushed) continue
      lastPushedRef.current.set(repo, pushed)
      const seq = beginRequest(repo)
      applyState(pushed, seq, repo)
    }
  }, [issueSnapshots, repoKey, beginRequest, applyState])

  const pending = useMemo(() => {
    const list = repoKey ? repoKey.split("\n") : []
    return list.some((root) => !(root in data) && !(root in failed))
  }, [repoKey, data, failed])

  return { data, failed, loading, pending, refresh }
}
