/**
 * First-run onboarding — the pure apply half. Matters because it edits the
 * user's REAL shell rc: the append must be idempotent (an onboarding re-run
 * or a `kobe completions` marker already present must never stack duplicate
 * source lines), and fish must get an autoload file, not an rc edit.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { detectShell, installCompletions } from "../../src/cli/onboarding.ts"

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "kobe-onboarding-"))
}

describe("detectShell", () => {
  it("maps $SHELL basenames to the supported shells", () => {
    expect(detectShell({ SHELL: "/bin/zsh" })).toBe("zsh")
    expect(detectShell({ SHELL: "/opt/homebrew/bin/bash" })).toBe("bash")
    expect(detectShell({ SHELL: "/usr/local/bin/fish" })).toBe("fish")
  })

  it("unknown or missing $SHELL is null (the wizard skips the step)", () => {
    expect(detectShell({ SHELL: "/bin/tcsh" })).toBeNull()
    expect(detectShell({})).toBeNull()
  })
})

describe("installCompletions", () => {
  it("appends one guarded source line to a missing .zshrc", () => {
    const home = freshHome()
    const rc = installCompletions("zsh", home)
    expect(rc).toBe(join(home, ".zshrc"))
    const content = readFileSync(rc, "utf8")
    expect(content).toContain("source <(kobe completions zsh)")
    expect(content).toContain("command -v kobe")
  })

  it("is idempotent — a second run never stacks a duplicate line", () => {
    const home = freshHome()
    installCompletions("zsh", home)
    installCompletions("zsh", home)
    const content = readFileSync(join(home, ".zshrc"), "utf8")
    expect(content.match(/kobe completions zsh/g)).toHaveLength(1)
  })

  it("preserves an existing rc and respects a hand-rolled kobe completions block", () => {
    const home = freshHome()
    const rc = join(home, ".bashrc")
    writeFileSync(rc, "# mine\nsource ~/.bash_completion.d/kobe # kobe completions via fpath\n")
    installCompletions("bash", home)
    const content = readFileSync(rc, "utf8")
    expect(content).toContain("# mine")
    // The marker was already present → nothing appended.
    expect(content).not.toContain("source <(kobe completions bash)")
  })

  it("fish gets an autoloaded completions file, no rc edit", () => {
    const home = freshHome()
    const path = installCompletions("fish", home)
    expect(path).toBe(join(home, ".config", "fish", "completions", "kobe.fish"))
    expect(readFileSync(path, "utf8")).toBe("kobe completions fish | source\n")
    expect(existsSync(join(home, ".config", "fish", "config.fish"))).toBe(false)
  })
})
