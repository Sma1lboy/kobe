/**
 * Unit tests for `detectClaudeAccount` / `detectCodexAccount`.
 *
 * We pin every fs read + binary probe through injected `DetectDeps`,
 * so these tests are deterministic and don't touch the developer's
 * real `~/.claude.json` or `~/.codex/auth.json`.
 *
 * Why these tests matter — the on-disk shapes are external contracts
 * (anthropic's `claude` CLI and openai's `codex` CLI own them). If we
 * silently regress the parsing — e.g. mis-spell `oauthAccount`, drop
 * the JWT padding fix, swallow a parse error as "not logged in" — the
 * Accounts panel lies about login state. Tests below pin the happy
 * paths and the error-vs-none distinction.
 */

import { ClaudeBinaryNotFoundError } from "@/engine/claude-code-local/binary"
import { CodexBinaryNotFoundError } from "@/engine/codex-local/binary"
import {
  claudeGlobalConfigPath,
  codexAuthPath,
  detectClaudeAccount,
  detectCodexAccount,
  type DetectDeps,
} from "@/engine/account-detect"
import { describe, expect, it } from "vitest"

function makeDeps(overrides: Partial<DetectDeps> = {}): DetectDeps {
  return {
    readFile: () => null,
    env: () => undefined,
    home: () => "/home/user",
    findClaudeBinary: async () => "/usr/local/bin/claude",
    findCodexBinary: async () => "/usr/local/bin/codex",
    ...overrides,
  }
}

// A real JWT-style id_token would be header.payload.signature, where
// payload is base64url(JSON). The signature is opaque to us — we never
// verify it. So we just need a parseable header and payload.
function makeJwt(payload: object): string {
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(payload)}.signature`
}

describe("claudeGlobalConfigPath", () => {
  it("defaults to ~/.claude.json", () => {
    expect(claudeGlobalConfigPath(() => undefined, "/home/user")).toBe("/home/user/.claude.json")
  })
  it("honours CLAUDE_CONFIG_DIR", () => {
    expect(claudeGlobalConfigPath((k) => (k === "CLAUDE_CONFIG_DIR" ? "/custom/cfg" : undefined), "/home/user")).toBe(
      "/custom/cfg/.claude.json",
    )
  })
})

describe("codexAuthPath", () => {
  it("defaults to ~/.codex/auth.json", () => {
    expect(codexAuthPath(() => undefined, "/home/user")).toBe("/home/user/.codex/auth.json")
  })
  it("honours CODEX_HOME", () => {
    expect(codexAuthPath((k) => (k === "CODEX_HOME" ? "/elsewhere/codex" : undefined), "/home/user")).toBe(
      "/elsewhere/codex/auth.json",
    )
  })
})

describe("detectClaudeAccount", () => {
  it("reports binary path + 'none' when no config file exists", async () => {
    const r = await detectClaudeAccount(makeDeps())
    expect(r.binary).toEqual({ found: true, path: "/usr/local/bin/claude" })
    expect(r.account).toEqual({ kind: "none" })
    expect(r.accountError).toBeUndefined()
  })

  it("extracts email + organization + displayName + billingType from oauthAccount", async () => {
    const config = {
      numStartups: 42,
      oauthAccount: {
        accountUuid: "abc",
        emailAddress: "jane@example.com",
        organizationName: "Jane's Org",
        displayName: "Jane",
        billingType: "stripe_subscription",
      },
    }
    const r = await detectClaudeAccount(
      makeDeps({
        readFile: (p) => (p === "/home/user/.claude.json" ? JSON.stringify(config) : null),
      }),
    )
    expect(r.account).toEqual({
      kind: "oauth",
      email: "jane@example.com",
      organization: "Jane's Org",
      displayName: "Jane",
      billingType: "stripe_subscription",
    })
  })

  it("reports 'none' when config exists but oauthAccount is absent", async () => {
    const r = await detectClaudeAccount(
      makeDeps({ readFile: () => JSON.stringify({ numStartups: 1 }) }),
    )
    expect(r.account).toEqual({ kind: "none" })
    expect(r.accountError).toBeUndefined()
  })

  it("surfaces parse errors as accountError (NOT as 'not logged in')", async () => {
    const r = await detectClaudeAccount(
      makeDeps({ readFile: () => "{ this is not json" }),
    )
    expect(r.account).toEqual({ kind: "none" })
    expect(r.accountError).toMatch(/parse .*\.claude\.json/)
  })

  it("reports binary not-found cleanly without losing account detection", async () => {
    const r = await detectClaudeAccount(
      makeDeps({
        findClaudeBinary: async () => {
          throw new ClaudeBinaryNotFoundError(["/nowhere"])
        },
        readFile: () => JSON.stringify({ oauthAccount: { emailAddress: "x@y.z" } }),
      }),
    )
    expect(r.binary).toEqual({ found: false, error: "not found on PATH" })
    expect(r.account).toEqual({ kind: "oauth", email: "x@y.z" })
  })

  it("respects CLAUDE_CONFIG_DIR", async () => {
    let observed = ""
    const r = await detectClaudeAccount(
      makeDeps({
        env: (k) => (k === "CLAUDE_CONFIG_DIR" ? "/custom" : undefined),
        readFile: (p) => {
          observed = p
          return null
        },
      }),
    )
    expect(observed).toBe("/custom/.claude.json")
    expect(r.account).toEqual({ kind: "none" })
  })
})

describe("detectCodexAccount", () => {
  it("reports 'none' when no auth file exists", async () => {
    const r = await detectCodexAccount(makeDeps())
    expect(r.binary).toEqual({ found: true, path: "/usr/local/bin/codex" })
    expect(r.account).toEqual({ kind: "none" })
  })

  it("decodes ChatGPT login: email + plan from id_token JWT", async () => {
    const idToken = makeJwt({
      email: "jane@example.com",
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    })
    const r = await detectCodexAccount(
      makeDeps({
        readFile: () =>
          JSON.stringify({
            OPENAI_API_KEY: null,
            tokens: { id_token: idToken },
          }),
      }),
    )
    expect(r.account).toEqual({ kind: "chatgpt", email: "jane@example.com", plan: "plus" })
  })

  it("falls back to API key login when no id_token but OPENAI_API_KEY is set", async () => {
    const r = await detectCodexAccount(
      makeDeps({
        readFile: () => JSON.stringify({ OPENAI_API_KEY: "sk-test-123", tokens: {} }),
      }),
    )
    expect(r.account).toEqual({ kind: "apikey" })
  })

  it("treats null OPENAI_API_KEY + no id_token as 'not logged in'", async () => {
    const r = await detectCodexAccount(
      makeDeps({
        readFile: () => JSON.stringify({ OPENAI_API_KEY: null, tokens: {} }),
      }),
    )
    expect(r.account).toEqual({ kind: "none" })
    expect(r.accountError).toBeUndefined()
  })

  it("surfaces malformed JWT as accountError (NOT as 'not logged in')", async () => {
    const r = await detectCodexAccount(
      makeDeps({
        readFile: () =>
          JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "not.a.jwt.too.many.parts" } }),
      }),
    )
    expect(r.account).toEqual({ kind: "none" })
    expect(r.accountError).toMatch(/id_token/)
  })

  it("surfaces JWT with no email claim", async () => {
    const idToken = makeJwt({ sub: "user-1" })
    const r = await detectCodexAccount(
      makeDeps({
        readFile: () => JSON.stringify({ tokens: { id_token: idToken } }),
      }),
    )
    expect(r.account).toEqual({ kind: "none" })
    expect(r.accountError).toMatch(/no email/)
  })

  it("surfaces JSON parse errors", async () => {
    const r = await detectCodexAccount(
      makeDeps({ readFile: () => "{ not json" }),
    )
    expect(r.account).toEqual({ kind: "none" })
    expect(r.accountError).toMatch(/parse .*auth\.json/)
  })

  it("reports binary not-found cleanly", async () => {
    const r = await detectCodexAccount(
      makeDeps({
        findCodexBinary: async () => {
          throw new CodexBinaryNotFoundError(["/nowhere"])
        },
      }),
    )
    expect(r.binary).toEqual({ found: false, error: "not found on PATH" })
  })

  it("respects CODEX_HOME", async () => {
    let observed = ""
    await detectCodexAccount(
      makeDeps({
        env: (k) => (k === "CODEX_HOME" ? "/elsewhere" : undefined),
        readFile: (p) => {
          observed = p
          return null
        },
      }),
    )
    expect(observed).toBe("/elsewhere/auth.json")
  })
})
