import { spawnSync } from "node:child_process"
import { CURRENT_VERSION, repoSlug } from "../version.ts"

export const DEFAULT_FEEDBACK_CATEGORY_SLUG = "general"

type SpawnSync = typeof spawnSync

type FeedbackDeps = {
  spawn: SpawnSync
  repoSlug: () => string | null
}

export type SubmitFeedbackInput = {
  title: string
  body: string
  categorySlug?: string
}

export type SubmitFeedbackResult = {
  number: number
  url: string
}

type GraphqlError = {
  message?: unknown
}

type GraphqlEnvelope<T> = {
  data?: T
  errors?: GraphqlError[]
}

type DiscussionCategory = {
  id: string
  name: string
  slug: string
}

type RepositoryCategoriesData = {
  repository?: {
    id?: string
    discussionCategories?: {
      nodes?: DiscussionCategory[]
    }
  }
}

type CreateDiscussionData = {
  createDiscussion?: {
    discussion?: {
      number?: number
      url?: string
    }
  }
}

const DISCUSSION_CATEGORY_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    discussionCategories(first: 50) {
      nodes {
        id
        name
        slug
      }
    }
  }
}
`

const CREATE_DISCUSSION_MUTATION = `
mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
  createDiscussion(input: {
    repositoryId: $repositoryId,
    categoryId: $categoryId,
    title: $title,
    body: $body
  }) {
    discussion {
      number
      url
    }
  }
}
`

function parseRepoSlug(slug: string): { owner: string; name: string } {
  const [owner, name] = slug.split("/")
  if (!owner || !name) throw new Error(`invalid GitHub repository slug: ${slug}`)
  return { owner, name }
}

function normalizeText(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  return trimmed
}

function graphqlErrorMessage(stderr: string, errors: GraphqlError[] | undefined): string {
  const messages = errors
    ?.map((err) => (typeof err.message === "string" ? err.message : null))
    .filter((msg): msg is string => !!msg)
  if (messages && messages.length > 0) return messages.join("; ")
  return stderr.trim() || "GitHub CLI returned an empty response"
}

function runGhGraphql<T>(query: string, variables: Record<string, string>, deps: Pick<FeedbackDeps, "spawn">): T {
  const args = ["api", "graphql", "-f", `query=${query}`]
  for (const [key, value] of Object.entries(variables)) args.push("-f", `${key}=${value}`)

  const result = deps.spawn("gh", args, { encoding: "utf8" })
  if (result.error) throw new Error(`failed to run gh: ${result.error.message}`)

  const stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "")
  const stderr = typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? "")
  let parsed: GraphqlEnvelope<T>
  try {
    parsed = JSON.parse(stdout) as GraphqlEnvelope<T>
  } catch {
    throw new Error(`failed to parse gh response: ${graphqlErrorMessage(stderr, undefined)}`)
  }

  if ((result.status ?? 0) !== 0 || parsed.errors?.length) {
    throw new Error(graphqlErrorMessage(stderr, parsed.errors))
  }
  if (!parsed.data) throw new Error("GitHub CLI response did not include data")
  return parsed.data
}

function discussionBody(body: string): string {
  return `${body}\n\n---\nSubmitted from kobe ${CURRENT_VERSION}.`
}

export function submitFeedback(input: SubmitFeedbackInput, deps: Partial<FeedbackDeps> = {}): SubmitFeedbackResult {
  const title = normalizeText(input.title, "feedback title")
  const body = discussionBody(normalizeText(input.body, "feedback body"))
  const slug = (deps.repoSlug ?? repoSlug)()
  if (!slug) throw new Error("package repository is not a GitHub repository")

  const { owner, name } = parseRepoSlug(slug)
  const categorySlug = input.categorySlug?.trim() || DEFAULT_FEEDBACK_CATEGORY_SLUG
  const io = { spawn: deps.spawn ?? spawnSync }

  const categoryData = runGhGraphql<RepositoryCategoriesData>(DISCUSSION_CATEGORY_QUERY, { owner, name }, io)
  const repository = categoryData.repository
  const repositoryId = repository?.id
  if (!repositoryId) throw new Error(`GitHub repository not found: ${slug}`)
  const category = repository.discussionCategories?.nodes?.find((node) => node.slug === categorySlug)
  if (!category) throw new Error(`GitHub Discussion category not found: ${categorySlug}`)

  const createData = runGhGraphql<CreateDiscussionData>(
    CREATE_DISCUSSION_MUTATION,
    {
      repositoryId,
      categoryId: category.id,
      title,
      body,
    },
    io,
  )
  const discussion = createData.createDiscussion?.discussion
  if (!discussion?.url || typeof discussion.number !== "number") {
    throw new Error("GitHub did not return the created Discussion")
  }
  return { number: discussion.number, url: discussion.url }
}
