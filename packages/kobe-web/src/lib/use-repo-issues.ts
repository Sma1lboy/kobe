/**
 * use-repo-issues — the issue-snapshot data plumbing extracted from the old
 * IssuesPage so the unified Board can render a repo's issues without
 * re-deriving the fetch/seq/live-push machinery.
 *
 * Two truth sources, merged per repo into one cache:
 *   1. an initial `/api/issues` GET per repo (and on demand via `refresh`);
 *   2. live `issue.snapshot` daemon pushes (any surface — another browser,
 *      the TUI, `kobe api issue-*`) replayed through the store's
 *      `issueSnapshots`.
 * An out-of-order guard (the DiffView seqRef pattern, per repo) stamps every
 * request and drops a stale response, so an in-flight GET can never overwrite
 * a fresher mutation/push. There is NO optimistic layer — the daemon issue
 * store is the only truth (the board optimistically HIDES a just-started issue
 * by a separate task-side mechanism, not here).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fetchIssues, type RepoIssues } from "./issues.ts"
import { normalizeRepoPath } from "./repo-key.ts"
import { useAppState } from "./store.ts"

export interface RepoIssuesResult {
  /** repoRoot → loaded issue state (GET + live pushes, seq-guarded). */
  readonly data: Record<string, RepoIssues>
  /** repoRoot → load-failure message (cleared once a fresh state lands). */
  readonly failed: Record<string, string>
  /** A `/api/issues` batch is in flight. */
  readonly loading: boolean
  /** The FIRST result (GET/push or failure) hasn't landed yet for at least
   *  one requested repo. Unlike `loading` — a refresh-batch flag set inside an
   *  effect that only flips AFTER the initial paint — `pending` is derived from
   *  data/failed presence, so it reads `true` on the very first render. Gate an
   *  empty-state on this, not on row count, or the "no issues" copy flashes for
   *  one frame before the initial GET resolves (the board's load twitch). */
  readonly pending: boolean
  /** Re-fetch the given repos (e.g. a manual refresh button). */
  readonly refresh: (roots: readonly string[]) => void
}

/**
 * Plumb a set of source repos' issues. `repos` is the canonical repo-key list
 * (e.g. from `issueRepoOptions`); membership changes trigger a parallel
 * initial fetch. Pass a STABLE-membership list — the hook keys its effect on
 * the joined repo set, not array identity.
 */
export function useRepoIssues(repos: readonly string[]): RepoIssuesResult {
  const { issueSnapshots } = useAppState()
  const [data, setData] = useState<Record<string, RepoIssues>>({})
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  // Out-of-order guard (DiffView seqRef pattern, per repo): every request
  // captures a token when it starts; applyState drops a response whose token
  // is older than the last one applied for that repo. Mutations/pushes bump
  // the token too, so an in-flight refresh GET can't clobber a fresher state.
  const seqRef = useRef(new Map<string, number>())
  const appliedSeqRef = useRef(new Map<string, number>())
  // The exact snapshot ref last applied per repo. The store preserves the ref
  // of an UNCHANGED repo's snapshot when a DIFFERENT repo's snapshot updates
  // (applyIssueSnapshotEvent spreads the map, replacing only the changed key),
  // so we re-run the push effect on every `issueSnapshots` change but skip
  // repos whose push didn't actually change. Without this, an unrelated repo's
  // push re-applied this repo's stale snapshot with a fresh seq, briefly
  // reverting a just-fetched newer state (and burning renders).
  const lastPushedRef = useRef(new Map<string, RepoIssues>())
  // Board key → the daemon's CANONICAL repoRoot (its realpath'd git main
  // worktree), learned from a GET/push response. A live `issue.snapshot` is
  // keyed by that canonical path, which can differ from the board's raw
  // task.repo key by MORE than a trailing slash — e.g. a symlinked repo path
  // (`/tmp/...` → `/private/tmp/...` on macOS) — so `normalizeRepoPath` alone
  // won't fold them together and a cross-surface push (TUI / `kobe api` /
  // another browser) would land under a key the board never reads. Recording
  // the canonical alias lets the live-push matcher find it.
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
      // The daemon's canonical repoRoot for this board key (before we rewrite
      // the stored repoRoot to the board key below). Lets a later live push —
      // which arrives keyed by that canonical path — match this board column.
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

  // Fetch every repo's issues in parallel when the repo set settles or its
  // membership changes (keyed by membership, not array identity — the upstream
  // repos list refreshes constantly).
  const repoKey = useMemo(() => [...repos].join("\n"), [repos])
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoKey is the membership fingerprint; refresh is stable. Refetching on every `repos` identity would hammer the bridge.
  useEffect(() => {
    refresh(repoKey ? repoKey.split("\n") : [])
  }, [repoKey])

  // Live daemon broadcasts: an issue mutation from any surface arrives as the
  // repo's full RepoIssues state. Cache it under every matching repo key so
  // `/repo` and `/repo/` don't split the UI cache.
  useEffect(() => {
    const byNormalized = new Map(
      Object.values(issueSnapshots).map((state) => [
        normalizeRepoPath(state.repoRoot),
        state,
      ]),
    )
    for (const repo of repoKey ? repoKey.split("\n") : []) {
      // Match by the board key's normalized path first; fall back to the
      // canonical repoRoot a prior GET resolved for it, so a push keyed by a
      // realpath'd/symlink-resolved path still finds this column.
      const canonical = canonicalRef.current.get(repo)
      const pushed =
        byNormalized.get(normalizeRepoPath(repo)) ??
        (canonical ? byNormalized.get(normalizeRepoPath(canonical)) : undefined)
      if (!pushed) continue
      // Already applied this exact push → skip (an unrelated repo's change
      // re-ran this effect). Only a genuinely new snapshot ref should win.
      if (lastPushedRef.current.get(repo) === pushed) continue
      lastPushedRef.current.set(repo, pushed)
      const seq = beginRequest(repo)
      applyState(pushed, seq, repo)
    }
  }, [issueSnapshots, repoKey, beginRequest, applyState])

  // Derived first-paint loading signal: a requested repo with neither an
  // applied state nor a recorded failure has no result yet. Computed from
  // data/failed (not the `loading` flag) so it's already true before the fetch
  // effect runs — that's what lets a consumer skip the misleading empty state.
  const pending = useMemo(() => {
    const list = repoKey ? repoKey.split("\n") : []
    return list.some((root) => !(root in data) && !(root in failed))
  }, [repoKey, data, failed])

  return { data, failed, loading, pending, refresh }
}
