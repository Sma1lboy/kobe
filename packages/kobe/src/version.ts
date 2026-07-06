import pkg from "../package.json" with { type: "json" }
import { isDev } from "./env.ts"

export const CURRENT_VERSION: string = pkg.version

export const PACKAGE_NAME: string = pkg.name

export function repoSlug(): string | null {
  const url = (pkg.repository as { url?: string } | undefined)?.url
  if (!url) return null
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
  if (!m || !m[1] || !m[2]) return null
  return `${m[1]}/${m[2]}`
}

export const UPDATE_SCRIPT_URL = "https://raw.githubusercontent.com/Sma1lboy/kobe/main/scripts/update.sh"

export const UPDATE_COMMAND = `curl -fsSL ${UPDATE_SCRIPT_URL} | sh`

export function recommendedGlobalInstallCommand(): string {
  return `npm install -g ${PACKAGE_NAME}@latest`
}

const FETCH_TIMEOUT_MS = 3_000

export type UpdateInfo = {
  current: string
  latest: string
  hasUpdate: boolean
}

async function fetchLatestFromRegistry(packageName: string): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const encoded = packageName.replace("/", "%2F")
    const res = await fetch(`https://registry.npmjs.org/${encoded}/latest`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    if (typeof body.version !== "string") return null
    return body.version
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function isNewerSemver(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0
}

export function compareSemver(aVersion: string, bVersion: string): number {
  const norm = (v: string) => v.split("-")[0] ?? v
  const a = norm(aVersion)
    .split(".")
    .map((s) => Number.parseInt(s, 10))
  const b = norm(bVersion)
    .split(".")
    .map((s) => Number.parseInt(s, 10))
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (Number.isNaN(av) || Number.isNaN(bv)) return 0
    if (av > bv) return 1
    if (av < bv) return -1
  }
  return 0
}

export async function checkLatestVersion(opts: { force?: boolean } = {}): Promise<UpdateInfo | null> {
  const fake = process.env.KOBE_FAKE_UPDATE
  if (fake) {
    return { current: CURRENT_VERSION, latest: fake, hasUpdate: isNewerSemver(fake, CURRENT_VERSION) }
  }

  if (isDev() && !opts.force) return null

  const latest = await fetchLatestFromRegistry(PACKAGE_NAME)
  if (!latest) return null
  return {
    current: CURRENT_VERSION,
    latest,
    hasUpdate: isNewerSemver(latest, CURRENT_VERSION),
  }
}

export type ReleaseNotes = {
  body: string
  url: string
  version: string
}

export type ReleaseNotesRangeItem = ReleaseNotes

export type ReleaseSummary = {
  version: string
  url: string
}

function versionFromTagName(tagName: unknown): string | null {
  if (typeof tagName !== "string") return null
  const match = tagName.match(/^v(\d+\.\d+\.\d+)$/)
  return match?.[1] ?? null
}

export async function fetchReleaseNotes(version: string): Promise<ReleaseNotes | null> {
  const slug = repoSlug()
  if (!slug) return null
  const tag = `v${version}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/tags/${tag}`, {
      signal: ctrl.signal,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { body?: unknown; html_url?: unknown }
    if (typeof body.body !== "string" || typeof body.html_url !== "string") return null
    return { body: body.body, url: body.html_url, version }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchReleaseNotesRange(args: {
  current: string
  latest: string
  limit?: number
}): Promise<ReleaseNotesRangeItem[]> {
  const slug = repoSlug()
  if (!slug) return []
  const limit = args.limit ?? 100
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases?per_page=${limit}`, {
      signal: ctrl.signal,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    })
    if (!res.ok) return []
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; body?: unknown }[]
    if (!Array.isArray(body)) return []
    return body
      .map((release) => {
        const version = versionFromTagName(release.tag_name)
        if (!version || typeof release.html_url !== "string" || typeof release.body !== "string") return null
        if (compareSemver(version, args.current) <= 0) return null
        if (compareSemver(version, args.latest) > 0) return null
        return { version, url: release.html_url, body: release.body }
      })
      .filter((release): release is ReleaseNotesRangeItem => release !== null)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchReleaseSummaries(limit = 12): Promise<ReleaseSummary[]> {
  const slug = repoSlug()
  if (!slug) return []
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases?per_page=${limit}`, {
      signal: ctrl.signal,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    })
    if (!res.ok) return []
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown }[]
    if (!Array.isArray(body)) return []
    return body
      .map((release) => {
        const version = versionFromTagName(release.tag_name)
        if (!version || typeof release.html_url !== "string") return null
        return { version, url: release.html_url }
      })
      .filter((release): release is ReleaseSummary => release !== null)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

export function releasePageUrl(version: string): string | null {
  const slug = repoSlug()
  if (!slug) return null
  return `https://github.com/${slug}/releases/tag/v${version}`
}
