/**
 * Edge-case coverage for `src/engine/account-detect.ts` beyond what
 * `account-detect.test.ts` already pins (happy-path oauth/JWT/apikey
 * detection, vendor-list memoization). This file covers:
 *   - `claudeGlobalConfigPath` / `codexAuthPath` / `copilotConfigPath`'s
 *     env-override vs default-home resolution.
 *   - Error paths in `detectClaudeAccount` / `detectCodexAccount` /
 *     `detectCopilotAccount`: readFile throwing, JSON.parse failing,
 *     malformed JWT, id_token-with-no-email, non-object oauthAccount,
 *     non-record parsed config.
 *   - `availableEngineIds`, which layers `getCustomEngineIds()` (real
 *     state.json, redirected via `KOBE_HOME_DIR` per the
 *     `test/state/repos.test.ts` convention) on top of the binary probe.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type DetectDeps,
  availableEngineIds,
  claudeGlobalConfigPath,
  codexAuthPath,
  copilotConfigPath,
  detectClaudeAccount,
  detectCodexAccount,
  detectCopilotAccount,
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

describe("config path resolvers", () => {
  it("claudeGlobalConfigPath prefers CLAUDE_CONFIG_DIR over home", () => {
    expect(claudeGlobalConfigPath((k) => (k === "CLAUDE_CONFIG_DIR" ? "/custom" : undefined), "/home/u")).toBe(
      "/custom/.claude.json",
    )
    expect(claudeGlobalConfigPath(() => undefined, "/home/u")).toBe("/home/u/.claude.json")
  })

  it("codexAuthPath prefers CODEX_HOME over home", () => {
    expect(codexAuthPath((k) => (k === "CODEX_HOME" ? "/custom/.codex" : undefined), "/home/u")).toBe(
      "/custom/.codex/auth.json",
    )
    expect(codexAuthPath(() => undefined, "/home/u")).toBe("/home/u/.codex/auth.json")
  })

  it("copilotConfigPath prefers COPILOT_HOME over home", () => {
    expect(copilotConfigPath((k) => (k === "COPILOT_HOME" ? "/custom/.copilot" : undefined), "/home/u")).toBe(
      "/custom/.copilot/config.json",
    )
    expect(copilotConfigPath(() => undefined, "/home/u")).toBe("/home/u/.copilot/config.json")
  })

  it("ignores a blank env override and falls back to home", () => {
    expect(claudeGlobalConfigPath(() => "   ", "/home/u")).toBe("/home/u/.claude.json")
  })
})

describe("detectClaudeAccount error paths", () => {
  it("surfaces a read error via accountError without throwing", async () => {
    const status = await detectClaudeAccount(
      deps({
        readFile: () => {
          throw new Error("EACCES")
        },
      }),
    )
    expect(status.account).toEqual({ kind: "none" })
    expect(status.accountError).toContain("EACCES")
  })

  it("surfaces a JSON parse error via accountError", async () => {
    const status = await detectClaudeAccount(deps({ readFile: () => "{not json" }))
    expect(status.account).toEqual({ kind: "none" })
    expect(status.accountError).toMatch(/parse/)
  })

  it("is 'none' when oauthAccount is missing or not an object", async () => {
    expect((await detectClaudeAccount(deps({ readFile: () => "{}" }))).account).toEqual({ kind: "none" })
    expect(
      (await detectClaudeAccount(deps({ readFile: () => JSON.stringify({ oauthAccount: "x" }) }))).account,
    ).toEqual({
      kind: "none",
    })
  })

  it("is 'none' when oauthAccount has no emailAddress", async () => {
    const status = await detectClaudeAccount(
      deps({ readFile: () => JSON.stringify({ oauthAccount: { organizationName: "Acme" } }) }),
    )
    expect(status.account).toEqual({ kind: "none" })
  })
})

describe("detectCodexAccount error paths", () => {
  it("is 'none' when the auth file is absent", async () => {
    expect((await detectCodexAccount(deps())).account).toEqual({ kind: "none" })
  })

  it("surfaces a read error via accountError", async () => {
    const status = await detectCodexAccount(
      deps({
        readFile: () => {
          throw new Error("EACCES")
        },
      }),
    )
    expect(status.accountError).toContain("EACCES")
  })

  it("surfaces a JSON parse error via accountError", async () => {
    const status = await detectCodexAccount(deps({ readFile: () => "{not json" }))
    expect(status.accountError).toMatch(/parse/)
  })

  it("surfaces a malformed JWT id_token as accountError", async () => {
    const status = await detectCodexAccount(
      deps({ readFile: () => JSON.stringify({ tokens: { id_token: "not.a.jwt.at.all" } }) }),
    )
    expect(status.account).toEqual({ kind: "none" })
    expect(status.accountError).toMatch(/malformed JWT/)
  })

  it("surfaces an id_token with no email claim as accountError", async () => {
    const idToken = jwt({ sub: "user-only-no-email" })
    const status = await detectCodexAccount(deps({ readFile: () => JSON.stringify({ tokens: { id_token: idToken } }) }))
    expect(status.account).toEqual({ kind: "none" })
    expect(status.accountError).toMatch(/no email claim/)
  })

  it("is 'none' when there's no id_token and no OPENAI_API_KEY", async () => {
    const status = await detectCodexAccount(deps({ readFile: () => JSON.stringify({ tokens: {} }) }))
    expect(status.account).toEqual({ kind: "none" })
  })

  it("ignores an empty-string OPENAI_API_KEY", async () => {
    const status = await detectCodexAccount(deps({ readFile: () => JSON.stringify({ OPENAI_API_KEY: "" }) }))
    expect(status.account).toEqual({ kind: "none" })
  })
})

describe("detectCopilotAccount error paths", () => {
  it("ignores a blank env token and falls through to config.json", async () => {
    const status = await detectCopilotAccount(
      deps({ env: (n) => (n === "GH_TOKEN" ? "   " : undefined), readFile: () => JSON.stringify({ token: "t" }) }),
    )
    expect(status.account).toEqual({ kind: "oauth" })
  })

  it("surfaces a read error via accountError", async () => {
    const status = await detectCopilotAccount(
      deps({
        readFile: () => {
          throw new Error("EACCES")
        },
      }),
    )
    expect(status.accountError).toContain("EACCES")
  })

  it("surfaces a JSON parse error via accountError", async () => {
    const status = await detectCopilotAccount(deps({ readFile: () => "{not json" }))
    expect(status.accountError).toMatch(/parse/)
  })

  it("is 'none' when the parsed config isn't an object", async () => {
    expect((await detectCopilotAccount(deps({ readFile: () => "42" }))).account).toEqual({ kind: "none" })
    expect((await detectCopilotAccount(deps({ readFile: () => "[1,2,3]" }))).account).toEqual({ kind: "none" })
  })

  it("finds a token key nested up to depth 4", async () => {
    const nested = { a: { b: { c: { d: { access_token: "deep" } } } } }
    const status = await detectCopilotAccount(deps({ readFile: () => JSON.stringify(nested) }))
    expect(status.account).toEqual({ kind: "oauth" })
  })

  it("does not find a token key past depth 4", async () => {
    const tooDeep = { a: { b: { c: { d: { e: { access_token: "deep" } } } } } }
    const status = await detectCopilotAccount(deps({ readFile: () => JSON.stringify(tooDeep) }))
    expect(status.account).toEqual({ kind: "none" })
  })
})

describe("availableEngineIds", () => {
  let tmpHome: string
  let originalHome: string | undefined

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-account-detect-"))
    originalHome = process.env.KOBE_HOME_DIR
    process.env.KOBE_HOME_DIR = tmpHome
  })

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env cleanup must fully unset when unset before the test.
    if (originalHome === undefined) delete process.env.KOBE_HOME_DIR
    else process.env.KOBE_HOME_DIR = originalHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it("appends registered custom engine ids after the detected built-ins", async () => {
    const stateDir = path.join(tmpHome, ".config", "kobe")
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ customEngineIds: ["my-custom-engine"] }))
    const ids = await availableEngineIds(deps({ findCopilotBinary: async () => "/bin/copilot" }))
    expect(ids).toEqual(["claude", "codex", "copilot", "my-custom-engine"])
  })

  it("returns just the built-ins when no custom engines are registered", async () => {
    const ids = await availableEngineIds(deps())
    expect(ids).toEqual(["claude", "codex", "copilot"])
  })
})
