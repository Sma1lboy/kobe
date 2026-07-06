import { textMatchesQuery } from "./text-match.ts"
import type { Issue, RepoIssues } from "./types.ts"

export interface BoardCard {
  repo: string
  issue: Issue
}

export function cardRepo(card: BoardCard): string {
  return card.repo
}

export interface BoardColumnSpec {
  key: string
  title: string
  accent: string
  alwaysVisible: boolean
}

export const BOARD_COLUMNS: readonly BoardColumnSpec[] = [
  {
    key: "backlog",
    title: "Backlog",
    accent: "text-subtle",
    alwaysVisible: true,
  },
  {
    key: "in_progress",
    title: "In progress",
    accent: "text-kobe-orange",
    alwaysVisible: true,
  },
  {
    key: "done",
    title: "Done",
    accent: "text-kobe-green",
    alwaysVisible: true,
  },
]

export interface BoardColumn extends BoardColumnSpec {
  cards: BoardCard[]
  hiddenCount: number
}

export const TERMINAL_COLUMN_CAP = 30
const TERMINAL_KEYS = new Set(["done"])

export function issueColumnKey(issue: Issue): string {
  if (issue.status === "done") return "done"
  if (issue.taskId !== undefined && issue.taskId !== "") return "in_progress"
  return "backlog"
}

export function isLinkedIssue(issue: Issue): boolean {
  return issue.taskId !== undefined && issue.taskId !== ""
}

export function compareCards(a: BoardCard, b: BoardCard): number {
  if (a.issue.created !== b.issue.created) {
    return a.issue.created < b.issue.created ? 1 : -1
  }
  return b.issue.id - a.issue.id
}

export function buildBoard(cards: BoardCard[]): BoardColumn[] {
  const byKey = new Map<string, BoardCard[]>()
  const push = (key: string, card: BoardCard): void => {
    const bucket = byKey.get(key)
    if (bucket) bucket.push(card)
    else byKey.set(key, [card])
  }
  for (const card of cards) {
    push(issueColumnKey(card.issue), card)
  }
  for (const bucket of byKey.values()) bucket.sort(compareCards)

  const capped = (
    key: string,
    bucket: BoardCard[],
  ): { cards: BoardCard[]; hiddenCount: number } => {
    if (!TERMINAL_KEYS.has(key) || bucket.length <= TERMINAL_COLUMN_CAP) {
      return { cards: bucket, hiddenCount: 0 }
    }
    return {
      cards: bucket.slice(0, TERMINAL_COLUMN_CAP),
      hiddenCount: bucket.length - TERMINAL_COLUMN_CAP,
    }
  }

  return BOARD_COLUMNS.map((spec) => ({
    ...spec,
    ...capped(spec.key, byKey.get(spec.key) ?? []),
  })).filter(
    (col) => col.alwaysVisible || col.cards.length + col.hiddenCount > 0,
  )
}

export function boardCardCount(columns: readonly BoardColumn[]): number {
  return columns.reduce((sum, col) => sum + col.cards.length, 0)
}

export interface ProjectBoard {
  readonly repo: string
  readonly label: string
  readonly columns: BoardColumn[]
}

export function buildProjectBoards(
  cards: readonly BoardCard[],
): ProjectBoard[] {
  const byRepo = new Map<string, BoardCard[]>()
  for (const card of cards) {
    const repo = card.repo
    const bucket = byRepo.get(repo)
    if (bucket) bucket.push(card)
    else byRepo.set(repo, [card])
  }
  const repos = [...byRepo.keys()]
  return repos
    .map((repo) => ({
      repo,
      label: labelRepo(repo, repos),
      columns: buildBoard(byRepo.get(repo) ?? []),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function repoBasename(repo: string): string {
  const trimmed = repo.replace(/\/+$/, "")
  return trimmed.split("/").pop() || trimmed
}

export function labelRepo(repo: string, repos: readonly string[]): string {
  const base = repoBasename(repo)
  const collides = repos.some((r) => r !== repo && repoBasename(r) === base)
  if (!collides) return base
  return repo.replace(/\/+$/, "").split("/").slice(-2).join("/")
}

export type PendingLinks = ReadonlyMap<string, { readonly taskId: string }>

export interface RepoChip {
  readonly repo: string
  readonly label: string
  readonly count: number
}

export interface BoardViewInput {
  readonly issueData: Record<string, RepoIssues>
  readonly issueRepos: readonly string[]
  readonly pendingLinks: PendingLinks
  readonly query: string
  readonly repoFilter: string | null
}

export interface BoardView {
  readonly allIssues: BoardCard[]
  readonly repoChips: RepoChip[]
  readonly projectBoards: ProjectBoard[]
  readonly shownCount: number
  readonly hasAnyCard: boolean
}

export function collectBoardIssues(
  issueData: Record<string, RepoIssues>,
  issueRepos: readonly string[],
  pendingLinks: PendingLinks,
): BoardCard[] {
  const out: BoardCard[] = []
  for (const repo of issueRepos) {
    const state = issueData[repo]
    if (!state || !state.exists) continue
    for (const issue of state.issues) {
      const pending = pendingLinks.get(`${repo}:${issue.id}`)
      out.push(
        pending && !issue.taskId
          ? { repo, issue: { ...issue, taskId: pending.taskId } }
          : { repo, issue },
      )
    }
  }
  return out
}

export function deriveRepoChips(cards: readonly BoardCard[]): RepoChip[] {
  const counts = new Map<string, number>()
  for (const { repo } of cards) counts.set(repo, (counts.get(repo) ?? 0) + 1)
  const keys = [...counts.keys()]
  return keys
    .map((repo) => ({
      repo,
      label: labelRepo(repo, keys),
      count: counts.get(repo) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function filterBoardCards(
  cards: readonly BoardCard[],
  query: string,
  repoFilter: string | null,
): BoardCard[] {
  return cards.filter(({ repo, issue }) => {
    if (repoFilter && repo !== repoFilter) return false
    return textMatchesQuery(`#${issue.id} ${issue.title} ${issue.body}`, query)
  })
}

export function buildBoardView(input: BoardViewInput): BoardView {
  const allIssues = collectBoardIssues(
    input.issueData,
    input.issueRepos,
    input.pendingLinks,
  )
  const repoChips = deriveRepoChips(allIssues)
  const boardIssues = filterBoardCards(allIssues, input.query, input.repoFilter)
  const projectBoards = buildProjectBoards(boardIssues)
  if (
    input.repoFilter &&
    projectBoards.length === 0 &&
    input.issueRepos.includes(input.repoFilter)
  ) {
    projectBoards.push({
      repo: input.repoFilter,
      label: labelRepo(input.repoFilter, input.issueRepos),
      columns: buildBoard([]),
    })
  }
  const shownCount = projectBoards.reduce(
    (sum, board) => sum + boardCardCount(board.columns),
    0,
  )
  return {
    allIssues,
    repoChips,
    projectBoards,
    shownCount,
    hasAnyCard: allIssues.length > 0,
  }
}
