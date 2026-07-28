#!/usr/bin/env node
// examples.github-start — create a kobe task from a GitHub issue or PR.
//
//   kobe plugin action invoke examples.github-start.start <issue-or-pr-url>
//
// Fetches title/body via the `gh` CLI, then calls back into kobe
// (`kobe api add --prompt …`) which creates the task, materializes the
// worktree, starts the engine, and delivers the prompt. The repo is the one
// you invoked the action from (KOBE_PLUGIN_INVOKE_CWD).

const { execFileSync, spawnSync } = require("node:child_process")

const url = process.argv[2]
const match = url?.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/)
if (!match) {
  console.error("usage: kobe plugin action invoke examples.github-start.start <github issue/pr url>")
  process.exit(2)
}
const [, owner, repo, kind, number] = match
const ghKind = kind === "pull" ? "pr" : "issue"

let item
try {
  item = JSON.parse(
    execFileSync("gh", [ghKind, "view", number, "--repo", `${owner}/${repo}`, "--json", "title,body,url"], {
      encoding: "utf8",
    }),
  )
} catch {
  console.error("`gh` failed — is the GitHub CLI installed and authenticated?")
  process.exit(1)
}

const repoDir = process.env.KOBE_PLUGIN_INVOKE_CWD || process.cwd()
const kobe = process.env.KOBE_BIN_PATH || "kobe"
const prompt = `Work on ${item.url}\n\n# ${item.title}\n\n${item.body || ""}`
const res = spawnSync(kobe, ["api", "add", "--repo", repoDir, "--title", item.title, "--prompt", prompt], {
  stdio: "inherit",
})
process.exit(res.status ?? 1)
