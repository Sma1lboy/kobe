/**
 * Claude Code changelog lookup for the welcome card. The CLI ships no
 * changelog API, so we read the public CHANGELOG.md (raw GitHub, CORS-open)
 * and slice out the `## <version>` section. Cached per-URL for the session so
 * expanding the card repeatedly costs one fetch.
 *
 * ponytail: Claude-only source URL — the only engine with a GUI banner today.
 * Generalize to a per-engine changelog URL when a second vendor needs it.
 */

const CHANGELOG_URL =
  "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md"

export interface ChangelogEntry {
  version: string
  notes: string[]
}

let cache: Promise<ChangelogEntry[]> | null = null

/** Split the markdown into `## <version>` sections with their `-` bullets. */
function parse(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let cur: ChangelogEntry | null = null
  for (const raw of md.split("\n")) {
    const head = raw.match(/^##\s+(\d+\.\d+\.\d+)\s*$/)
    if (head) {
      cur = { version: head[1], notes: [] }
      entries.push(cur)
      continue
    }
    const bullet = raw.match(/^[-*]\s+(.*\S)\s*$/)
    if (bullet && cur) cur.notes.push(bullet[1])
  }
  return entries
}

async function all(): Promise<ChangelogEntry[]> {
  if (!cache) {
    cache = fetch(CHANGELOG_URL)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then(parse)
      .catch(() => {
        cache = null // let a later expand retry
        return []
      })
  }
  return cache
}

/** The changelog entry for `version`, or the newest one when that exact
 *  version isn't listed yet (dev builds run ahead of the published log). */
export async function changelogFor(
  version: string,
): Promise<ChangelogEntry | null> {
  const entries = await all()
  if (entries.length === 0) return null
  return entries.find((e) => e.version === version) ?? entries[0]
}
