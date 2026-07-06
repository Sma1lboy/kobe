import { afterEach, describe, expect, it } from "vitest"
import {
  type DetectDeps,
  detectAvailableVendors,
  detectClaudeAccount,
  detectCodexAccount,
  detectCopilotAccount,
  resetAvailableVendorsCache,
} from "../../src/engine/account-detect.ts"

function deps(over: Partial<DetectDeps> = {}): DetectDeps {
  return {
    readFile: () => null,
    env: () => undefined,
    home: () => "/home/u",
    findClaudeBinary: async () => "/bin/claude",
    findCodexBinary: async () => "/bin/codex",
    findCopilotBinary: async () => "/bin/copilot",
    ...over,
  }
}

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`
}

describe("detectClaudeAccount", () => {
  it("reports the oauth email + org from ~/.claude.json", async () => {
    const status = await detectClaudeAccount(
      deps({
        readFile: () => JSON.stringify({ oauthAccount: { emailAddress: "a@b.com", organizationName: "Acme" } }),
      }),
    )
    expect(status.binary).toEqual({ found: true, path: "/bin/claude" })
    expect(status.account).toEqual({
      kind: "oauth",
      email: "a@b.com",
      organization: "Acme",
      displayName: undefined,
      billingType: undefined,
    })
  })

  it("is 'none' when the config file is absent", async () => {
    const status = await detectClaudeAccount(deps())
    expect(status.account).toEqual({ kind: "none" })
  })

  it("surfaces a binary-not-found without throwing", async () => {
    const status = await detectClaudeAccount(
      deps({
        findClaudeBinary: async () => {
          throw new Error("nope")
        },
      }),
    )
    expect(status.binary.found).toBe(false)
  })
})

describe("detectCodexAccount", () => {
  it("decodes the ChatGPT id_token email + plan", async () => {
    const idToken = jwt({ email: "c@d.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } })
    const status = await detectCodexAccount(deps({ readFile: () => JSON.stringify({ tokens: { id_token: idToken } }) }))
    expect(status.account).toEqual({ kind: "chatgpt", email: "c@d.com", plan: "pro" })
  })

  it("falls back to api-key login", async () => {
    const status = await detectCodexAccount(deps({ readFile: () => JSON.stringify({ OPENAI_API_KEY: "sk-x" }) }))
    expect(status.account).toEqual({ kind: "apikey" })
  })
})

describe("detectAvailableVendors", () => {
  const notFound = async () => {
    throw new Error("not on PATH")
  }

  it("lists every vendor whose binary resolves, in cycle order", async () => {
    expect(await detectAvailableVendors(deps())).toEqual(["claude", "codex", "copilot"])
  })

  it("excludes vendors whose binary is missing", async () => {
    const only = await detectAvailableVendors(deps({ findClaudeBinary: notFound, findCopilotBinary: notFound }))
    expect(only).toEqual(["codex"])
  })

  it("returns [] when no engine CLI is found", async () => {
    const none = await detectAvailableVendors(
      deps({ findClaudeBinary: notFound, findCodexBinary: notFound, findCopilotBinary: notFound }),
    )
    expect(none).toEqual([])
  })
})

describe("detectAvailableVendors caching", () => {
  afterEach(() => resetAvailableVendorsCache())

  it("memoizes the default-deps probe (same promise reference across calls)", () => {
    resetAvailableVendorsCache()
    const a = detectAvailableVendors()
    const b = detectAvailableVendors()
    expect(a).toBe(b)
  })

  it("re-probes after resetAvailableVendorsCache()", () => {
    const a = detectAvailableVendors()
    resetAvailableVendorsCache()
    const b = detectAvailableVendors()
    expect(a).not.toBe(b)
  })

  it("never caches custom-deps calls (each returns a fresh probe)", () => {
    const a = detectAvailableVendors(deps())
    const b = detectAvailableVendors(deps())
    expect(a).not.toBe(b)
  })
})

describe("detectCopilotAccount", () => {
  it("prefers an env token and names its source", async () => {
    const status = await detectCopilotAccount(deps({ env: (n) => (n === "GH_TOKEN" ? "ghp_x" : undefined) }))
    expect(status.account).toEqual({ kind: "token", source: "GH_TOKEN" })
  })

  it("detects an on-disk oauth login from config.json", async () => {
    const status = await detectCopilotAccount(deps({ readFile: () => JSON.stringify({ oauth_token: "tok" }) }))
    expect(status.account).toEqual({ kind: "oauth" })
  })

  it("is 'none' with no token and no config", async () => {
    expect((await detectCopilotAccount(deps())).account).toEqual({ kind: "none" })
  })
})
