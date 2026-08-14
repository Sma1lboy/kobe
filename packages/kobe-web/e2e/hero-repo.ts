/**
 * The repository the README capture is shot against.
 *
 * It has to read as a real project rather than a fixture: the file tree, the
 * diff pane, and whatever the engine actually edits are all on camera. Small
 * on purpose — a real turn against it finishes in one pass, and every file is
 * something a reader can hold in their head from the screenshot alone.
 */

export type HeroFile = { readonly path: string; readonly body: string }

export const HERO_FILES: readonly HeroFile[] = [
  {
    path: "package.json",
    body: `{
  "name": "orbit-sdk",
  "version": "0.4.2",
  "description": "Tiny typed client for the Orbit API.",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "bun test"
  }
}
`,
  },
  {
    path: "README.md",
    body: `# orbit-sdk

Tiny typed client for the Orbit API.

\`\`\`ts
import { createClient } from "orbit-sdk"

const orbit = createClient({ baseUrl: "https://api.orbit.dev" })
const me = await orbit.get("/v1/me")
\`\`\`

## Layout

| file | what it owns |
|---|---|
| \`src/client.ts\` | request builder, auth header, transport |
| \`src/session.ts\` | token cache and refresh |
| \`src/retry.ts\` | which failures are worth retrying |
`,
  },
  {
    path: "src/index.ts",
    body: `export { createClient } from "./client.ts"
export { getSession, refresh } from "./session.ts"
export { retryable } from "./retry.ts"
export type { Client, ClientOptions } from "./client.ts"
`,
  },
  {
    path: "src/client.ts",
    body: `import { getSession } from "./session.ts"
import { retryable } from "./retry.ts"

export type ClientOptions = { baseUrl: string; maxAttempts?: number }
export type Client = { get: (path: string) => Promise<Response> }

export function createClient({ baseUrl, maxAttempts = 3 }: ClientOptions): Client {
  async function once(path: string): Promise<Response> {
    const session = await getSession(Date.now())
    return fetch(\`\${baseUrl}\${path}\`, {
      headers: { authorization: \`Bearer \${session.token}\` },
    })
  }

  return {
    async get(path: string): Promise<Response> {
      let last: Response | undefined
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        last = await once(path)
        if (!retryable(last.status)) return last
        await new Promise((done) => setTimeout(done, 100 * attempt))
      }
      if (!last) throw new Error("no attempt was made")
      return last
    },
  }
}
`,
  },
  {
    path: "src/session.ts",
    body: `export type Session = { token: string; expiresAt: number }

let current: Session | undefined

export async function refresh(): Promise<Session> {
  const res = await fetch("https://auth.orbit.dev/v1/token", { method: "POST" })
  const body = (await res.json()) as { token: string; expires_in: number }
  current = { token: body.token, expiresAt: Date.now() + body.expires_in * 1000 }
  return current
}

export async function getSession(now: number): Promise<Session> {
  if (!current) return refresh()
  if (current.expiresAt - now > 30_000) return current
  return refresh()
}
`,
  },
  {
    path: "src/retry.ts",
    body: `/** Status codes worth a second attempt. */
const RETRYABLE = new Set([502, 503, 504])

export function retryable(status: number): boolean {
  return RETRYABLE.has(status)
}
`,
  },
  {
    path: "test/client.test.ts",
    body: `import { expect, test } from "bun:test"
import { retryable } from "../src/retry.ts"

test("gateway failures are retried", () => {
  expect(retryable(503)).toBe(true)
})

test("client errors are not retried", () => {
  expect(retryable(404)).toBe(false)
})
`,
  },
]

/** Commits the repo is seeded with, so the log reads like real history. */
export const HERO_COMMITS: readonly { readonly message: string; readonly paths: readonly string[] }[] = [
  { message: "feat: typed client for the Orbit API", paths: ["package.json", "README.md", "src/index.ts", "src/client.ts"] },
  { message: "feat: cache the session token until it expires", paths: ["src/session.ts"] },
  { message: "feat: retry gateway failures", paths: ["src/retry.ts", "test/client.test.ts"] },
]
