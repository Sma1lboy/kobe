import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

describe("active product copy", () => {
  test("landing copy describes the Hosted PTY runtime in both languages", () => {
    const landing = read("packages/kobe-landing/index.html")

    for (const stale of [
      "persistent tmux sessions",
      "tmux session",
      "Close your laptop",
      "合上笔记本",
      "需要 Bun ≥ 1.3.11、tmux",
    ]) {
      expect(landing).not.toContain(stale)
    }

    expect(landing).toContain("persistent hosted engine sessions")
    expect(landing).toContain("hosted engine sessions")
    expect(landing).toContain("standalone PTY Host")
    expect(landing).toContain("常驻 Hosted PTY 会话")
    expect(landing).toContain("独立 PTY Host")
    expect(landing).toContain("'workspace.sessions': '托管引擎会话'")
    expect(landing).toContain("Close kobe. Work keeps running.")
    expect(landing).toContain("退出 kobe，工作继续跑。")
  })

  test("active product surfaces do not present tmux as Kobe's backend", () => {
    const filesAndStalePhrases: Array<[string, string[]]> = [
      ["packages/kobe-web/src/components/ToolsPanel.tsx", ["tmux session and engine"]],
      ["packages/kobe-web/README.md", ["kobe-sandbox tmux socket"]],
      ["packages/kobe-desktop/README.md", ["does not kill the daemon or tmux sessions"]],
      [".claude/skills/release/SKILL.md", ["needs tmux", "apt-installed tmux"]],
      ["workspace/products/kobe/kobe/brand.meta.yaml", ["git worktrees, tmux sessions", "persistent tmux sessions"]],
    ]

    for (const [path, stalePhrases] of filesAndStalePhrases) {
      const source = read(path)
      for (const stale of stalePhrases) expect(source).not.toContain(stale)
    }

    expect(read("packages/kobe-web/src/components/ToolsPanel.tsx")).toContain("Its Hosted PTY sessions will be stopped")
    expect(read("workspace/products/kobe/kobe/brand.meta.yaml")).toContain("persistent hosted engine sessions")
  })

  test("current design guidance names the live runtime and migration gaps", () => {
    const tasks = read("docs/design/tasks.md")
    const web = read("docs/design/web-dashboard.md")
    const dispatcher = read("docs/design/dispatcher.md")
    const daemon = read("docs/design/daemon.md")
    const remote = read("docs/design/remote-projects.md")

    expect(tasks).not.toContain("inside a tmux pane/embedded terminal")
    expect(tasks).toContain("Hosted PTY session owned by the")
    expect(tasks).toContain("standalone PTY Host")

    expect(web).not.toContain("Ensure a task's tmux session")
    expect(web).not.toContain("killing the task's tmux session")
    expect(web).toContain("canonical standalone Hosted PTY engine session")
    expect(web).toContain("Browser-sidecar PTYs are a separate owner")

    expect(dispatcher).not.toContain("send` pastes via tmux")
    expect(dispatcher).toContain("canonical standalone Hosted PTY session")

    expect(daemon).not.toContain("never tears down tmux sessions")
    expect(daemon).toContain("standalone PTY Host, which survives daemon restarts")

    expect(remote).not.toContain("phases 1–6 done")
    expect(remote).toContain("Hosted PTY engine-launch parity requires revalidation")
    expect(remote).toContain("engine-over-SSH parity is currently pending")
  })
})
