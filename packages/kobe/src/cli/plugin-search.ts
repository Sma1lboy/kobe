/**
 * `kobe plugin search [query]` — browse the marketplace from the CLI.
 *
 * The marketplace is the GitHub topic `kobe-plugin` (docs/design/plugins.md
 * §Marketplace): one unauthenticated search-API call, merged with the
 * first-party examples that live in this repo (monorepo subdirs can never
 * carry a topic of their own). Same data the landing page renders.
 */

const SEARCH_TIMEOUT_MS = 5_000

/** First-party examples under Sma1lboy/kobe/plugins/ — also the offline fallback. */
const FIRST_PARTY: readonly { ref: string; desc: string }[] = [
  { ref: "Sma1lboy/kobe/plugins/notify", desc: "Desktop/ntfy notifications when an agent finishes or needs input" },
  { ref: "Sma1lboy/kobe/plugins/github-start", desc: "Start a kobe task from a GitHub issue or PR" },
  { ref: "Sma1lboy/kobe/plugins/worktree-include", desc: "Copy .worktreeinclude-matched files into new worktrees" },
  { ref: "Sma1lboy/kobe/plugins/linear-start", desc: "Pick a Linear issue (fzf) and start a task on its branch" },
  { ref: "Sma1lboy/kobe/plugins/lazygit", desc: "lazygit on the task worktree, as a pane tab" },
  { ref: "Sma1lboy/kobe/plugins/browser", desc: "Chromium rendered as terminal cells (carbonyl) in a pane tab" },
]

interface MarketEntry {
  readonly ref: string
  readonly desc: string
  readonly stars?: number
  readonly firstParty?: boolean
}

async function fetchCommunity(query: string | undefined): Promise<MarketEntry[] | null> {
  const q = encodeURIComponent(`topic:kobe-plugin${query ? ` ${query}` : ""}`)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS)
  try {
    const res = await fetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=50`, {
      signal: ctrl.signal,
      headers: { accept: "application/vnd.github+json" },
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      items?: { full_name?: string; description?: string; stargazers_count?: number }[]
    }
    if (!Array.isArray(body.items)) return null
    return body.items
      .filter((r) => typeof r.full_name === "string")
      .map((r) => ({ ref: r.full_name as string, desc: r.description ?? "", stars: r.stargazers_count }))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function searchMarketplace(query: string | undefined): Promise<void> {
  const community = await fetchCommunity(query)
  const lower = query?.toLowerCase()
  const seeds = FIRST_PARTY.filter((s) => !lower || `${s.ref} ${s.desc}`.toLowerCase().includes(lower)).map((s) => ({
    ...s,
    firstParty: true,
  }))
  const entries: MarketEntry[] = [...seeds, ...(community ?? [])]
  if (community === null) {
    console.error("(GitHub search unreachable — showing first-party plugins only)")
  }
  if (entries.length === 0) {
    console.log(query ? `no plugins match \`${query}\`` : "no plugins found")
    return
  }
  const width = Math.min(48, Math.max(...entries.map((e) => e.ref.length)) + 2)
  for (const e of entries) {
    const stars = e.stars !== undefined ? `★${e.stars}` : e.firstParty ? "first-party" : ""
    console.log(`${e.ref.padEnd(width)}${stars.padEnd(12)}${e.desc}`)
  }
  console.log("\ninstall: kobe plugin install <owner/repo[/subdir]> — browse: https://kobe.sma1lboy.me/plugins")
}
