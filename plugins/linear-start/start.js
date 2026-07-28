#!/usr/bin/env node
// examples.linear-start — start a kobe task from a Linear issue.
//
//   kobe plugin action invoke examples.linear-start.start [ISSUE-ID]
//
// With an id (e.g. KOB-12) it goes straight to `kobe api add`; without one it
// lists your open assigned issues and picks via fzf (numbered prompt when fzf
// is missing — action invokes inherit the terminal, so pickers just work).
// Config: LINEAR_API_KEY=lin_api_… in "$KOBE_PLUGIN_CONFIG_DIR/.env".

const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")

function apiKey() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY
  try {
    const env = fs.readFileSync(path.join(process.env.KOBE_PLUGIN_CONFIG_DIR, ".env"), "utf8")
    const m = env.match(/^LINEAR_API_KEY=(.+)$/m)
    if (m) return m[1].trim()
  } catch {}
  console.error('missing LINEAR_API_KEY — put it in "$(kobe plugin config-dir examples.linear-start)/.env"')
  process.exit(1)
}

async function gql(query, variables) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: apiKey() },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (body.errors) {
    console.error("Linear API error:", body.errors[0]?.message)
    process.exit(1)
  }
  return body.data
}

const ISSUE_FIELDS = "identifier title description branchName url"

async function pickIssue() {
  const data = await gql(
    `query { viewer { assignedIssues(
        filter: { state: { type: { nin: ["completed", "canceled"] } } }
        first: 50, orderBy: updatedAt
      ) { nodes { ${ISSUE_FIELDS} } } } }`,
  )
  const issues = data.viewer.assignedIssues.nodes
  if (issues.length === 0) {
    console.error("no open issues assigned to you")
    process.exit(1)
  }
  const lines = issues.map((i) => `${i.identifier}\t${i.title}`)
  const fzf = spawnSync("fzf", ["--with-nth=1,2", "--delimiter=\t", "--height=40%", "--reverse"], {
    input: lines.join("\n"),
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf8",
  })
  if (fzf.status === 0 && fzf.stdout) {
    const id = fzf.stdout.split("\t")[0].trim()
    return issues.find((i) => i.identifier === id)
  }
  if (fzf.error?.code !== "ENOENT") process.exit(1) // fzf present but user cancelled
  lines.forEach((l, n) => console.log(`${n + 1}. ${l}`))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolve) => rl.question("issue #: ", resolve))
  rl.close()
  const issue = issues[Number.parseInt(answer, 10) - 1]
  if (!issue) process.exit(1)
  return issue
}

async function main() {
  const arg = process.argv[2]
  const issue = arg
    ? (await gql(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: arg })).issue
    : await pickIssue()
  if (!issue) {
    console.error(`no such issue: ${arg}`)
    process.exit(1)
  }
  const repoDir = process.env.KOBE_PLUGIN_INVOKE_CWD || process.cwd()
  const kobe = process.env.KOBE_BIN_PATH || "kobe"
  const prompt = `Work on ${issue.identifier}: ${issue.url}\n\n# ${issue.title}\n\n${issue.description || ""}`
  const res = spawnSync(
    kobe,
    [
      "api", "add",
      "--repo", repoDir,
      "--title", `[${issue.identifier}] ${issue.title}`,
      "--branch", issue.branchName,
      "--prompt", prompt,
    ],
    { stdio: "inherit" },
  )
  process.exit(res.status ?? 1)
}

main()
