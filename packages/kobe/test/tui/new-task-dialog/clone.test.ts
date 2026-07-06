import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  deriveFolderName,
  findAvailableFolderName,
  resolveCloneTarget,
  validateCloneTarget,
  validateGitUrl,
} from "@/tui/component/new-task-dialog/clone"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

describe("deriveFolderName", () => {
  it("derives from https, SCP-form, and ssh URLs", () => {
    expect(deriveFolderName("https://github.com/foo/bar.git")).toBe("bar")
    expect(deriveFolderName("git@github.com:foo/bar.git")).toBe("bar")
    expect(deriveFolderName("ssh://git@host:22/foo/bar")).toBe("bar")
  })

  it("strips trailing slashes and tolerates non-URL input", () => {
    expect(deriveFolderName("https://example.com/path/repo/")).toBe("repo")
    expect(deriveFolderName("not-a-url")).toBe("not-a-url")
    expect(deriveFolderName("   ")).toBe("")
  })
})

describe("validateGitUrl", () => {
  it("requires non-empty input", () => {
    expect(validateGitUrl("  ")).toBe("git URL is required")
  })

  it("rejects only completely formless single tokens", () => {
    expect(validateGitUrl("nonsense")).toContain("does not look like a git URL")
  })

  it("accepts protocol, SCP-form, and local-path shapes", () => {
    expect(validateGitUrl("https://github.com/foo/bar.git")).toBeNull()
    expect(validateGitUrl("git@github.com:foo/bar.git")).toBeNull()
    expect(validateGitUrl("/local/repo")).toBeNull()
  })
})

describe("validateCloneTarget / resolveCloneTarget / findAvailableFolderName (tmpdir fixture)", () => {
  let parent: string
  beforeAll(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-clone-test-"))
    fs.mkdirSync(path.join(parent, "taken"))
    fs.mkdirSync(path.join(parent, "dup"))
    fs.mkdirSync(path.join(parent, "dup-2"))
  })
  afterAll(() => {
    fs.rmSync(parent, { recursive: true, force: true })
  })

  it("rejects empty / separator-bearing folder names before touching fs", () => {
    expect(validateCloneTarget(parent, "  ")).toBe("folder name is required")
    expect(validateCloneTarget(parent, "a/b")).toBe("folder name cannot contain path separators")
  })

  it("rejects a missing parent and an already-existing target", () => {
    expect(validateCloneTarget(path.join(parent, "nope"), "x")).toContain("parent directory does not exist")
    expect(validateCloneTarget(parent, "taken")).toContain("target already exists")
  })

  it("accepts a fresh target and composes its absolute path", () => {
    expect(validateCloneTarget(parent, "fresh")).toBeNull()
    expect(resolveCloneTarget(parent, "fresh")).toBe(path.join(parent, "fresh"))
  })

  it("auto-suffixes a colliding URL-derived folder name", () => {
    expect(findAvailableFolderName(parent, "fresh")).toBe("fresh")
    expect(findAvailableFolderName(parent, "taken")).toBe("taken-2")
    expect(findAvailableFolderName(parent, "dup")).toBe("dup-3")
  })

  it("returns the base verbatim when the parent is unusable (doesn't mask validation)", () => {
    expect(findAvailableFolderName(path.join(parent, "nope"), "taken")).toBe("taken")
  })
})
