import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { handleIssuesRequest, type Issue } from "../../kobe/src/web/issues.ts"

/**
 * Filesystem-route coverage for the /api/issues bridge route — a repo's
 * committed docs/issues.json surfaced to the dashboard. Driven directly
 * through handleIssuesRequest against fs.mkdtemp temp repos (no daemon, no
 * git); the bridge wire-in is the same one-line fallthrough as notes/diff,
 * covered by bridge-routes.test.ts's route-ordering cases.
 */

interface IssuesState {
  repoRoot: string
  exists: boolean
  nextId: number
  issues: Issue[]
}

const FIXTURE = {
  nextId: 4,
  issues: [
    { id: 3, title: "Newest open thing", status: "open", created: "2026-06-10", body: "third body" },
    { id: 1, title: "Fix the flicker", status: "doing", created: "2026-05-31", body: "tooltip body" },
    { id: 2, title: "Old done thing", status: "done", created: "2026-06-01", body: "" },
  ],
}

const cleanups: string[] = []

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** `git init` a directory the way the fixtures need it (no branch-name hint noise). */
function gitInit(dir: string): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet"], { cwd: dir })
}

/** Temp git repo with docs/issues.json (or just docs/, or neither; `git: false` skips git init). */
async function makeRepo(
  opts: { file?: unknown; docsDir?: boolean; git?: boolean } = { file: FIXTURE },
): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "kobe-issues-"))
  cleanups.push(repo)
  if (opts.git !== false) gitInit(repo)
  if (opts.docsDir !== false) await mkdir(join(repo, "docs"))
  if (opts.file !== undefined) {
    await writeFile(join(repo, "docs", "issues.json"), `${JSON.stringify(opts.file, null, 2)}\n`, "utf8")
  }
  return repo
}

function get(repoRoot: string): Promise<Response | null> {
  const url = new URL(`http://localhost/api/issues?repoRoot=${encodeURIComponent(repoRoot)}`)
  return handleIssuesRequest(new Request(url), url)
}

function post(body: unknown): Promise<Response | null> {
  const url = new URL("http://localhost/api/issues")
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return handleIssuesRequest(req, url)
}

async function readDisk(repoRoot: string): Promise<{ text: string; data: { nextId: number; issues: Issue[] } }> {
  const text = await readFile(join(repoRoot, "docs", "issues.json"), "utf8")
  return { text, data: JSON.parse(text) }
}

describe("GET /api/issues", () => {
  it("returns the parsed file for a repo with issues", async () => {
    const repo = await makeRepo()
    const res = await get(repo)
    expect(res?.status).toBe(200)
    const json = (await res?.json()) as IssuesState
    expect(json.repoRoot).toBe(repo)
    expect(json.exists).toBe(true)
    expect(json.nextId).toBe(4)
    expect(json.issues).toHaveLength(3)
    expect(json.issues[0]).toEqual(FIXTURE.issues[0])
  })

  it("reports a missing file as exists:false with empty state (200, no file created)", async () => {
    const repo = await makeRepo({ file: undefined })
    const res = await get(repo)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ repoRoot: repo, exists: false, nextId: 1, issues: [] })
    await expect(readFile(join(repo, "docs", "issues.json"), "utf8")).rejects.toThrow()
  })

  it("400s a relative repoRoot", async () => {
    const url = new URL("http://localhost/api/issues?repoRoot=../x")
    const res = await handleIssuesRequest(new Request(url), url)
    expect(res?.status).toBe(400)
  })

  it("400s a missing repoRoot", async () => {
    const url = new URL("http://localhost/api/issues")
    const res = await handleIssuesRequest(new Request(url), url)
    expect(res?.status).toBe(400)
  })

  it("400s a nonexistent repoRoot", async () => {
    const res = await get("/definitely/not/a/real/dir")
    expect(res?.status).toBe(400)
  })

  it("400s a directory that is not a git repository", async () => {
    const repo = await makeRepo({ git: false })
    const res = await get(repo)
    expect(res?.status).toBe(400)
    expect(((await res?.json()) as { error: string }).error).toContain("git")
  })

  it("round-trips a repo path containing a literal %20 and a trailing %", async () => {
    const parent = await mkdtemp(join(tmpdir(), "kobe-issues-pct-"))
    cleanups.push(parent)
    const repo = join(parent, "weird %20 repo%")
    await mkdir(repo)
    gitInit(repo)
    await mkdir(join(repo, "docs"))
    await writeFile(join(repo, "docs", "issues.json"), `${JSON.stringify(FIXTURE, null, 2)}\n`, "utf8")

    const getRes = await get(repo)
    expect(getRes?.status).toBe(200)
    expect(((await getRes?.json()) as IssuesState).repoRoot).toBe(repo)

    const postRes = await post({ repoRoot: repo, op: { type: "create", title: "Percent-safe" } })
    expect(postRes?.status).toBe(200)
    const { data } = await readDisk(repo)
    expect(data.issues.find((i) => i.id === 4)?.title).toBe("Percent-safe")
  })

  it("returns null for non-issues paths so the bridge falls through", async () => {
    const url = new URL("http://localhost/api/notes")
    expect(await handleIssuesRequest(new Request(url), url)).toBeNull()
  })

  it("405s an unsupported method", async () => {
    const url = new URL("http://localhost/api/issues")
    const res = await handleIssuesRequest(new Request(url, { method: "PUT" }), url)
    expect(res?.status).toBe(405)
  })
})

describe("POST /api/issues create", () => {
  it("allocates the id from nextId, bumps nextId, and writes the file", async () => {
    const repo = await makeRepo()
    const res = await post({ repoRoot: repo, op: { type: "create", title: "Ship it", body: "details here" } })
    expect(res?.status).toBe(200)
    const json = (await res?.json()) as IssuesState
    expect(json.nextId).toBe(5)
    const created = json.issues.find((i) => i.id === 4)
    expect(created).toMatchObject({ id: 4, title: "Ship it", status: "open", body: "details here" })
    expect(created?.created).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const { data } = await readDisk(repo)
    expect(data.nextId).toBe(5)
    expect(data.issues.find((i) => i.id === 4)?.title).toBe("Ship it")
  })

  it("creates docs/issues.json on first create when only docs/ exists", async () => {
    const repo = await makeRepo({ file: undefined })
    const res = await post({ repoRoot: repo, op: { type: "create", title: "First issue" } })
    expect(res?.status).toBe(200)
    const json = (await res?.json()) as IssuesState
    expect(json).toMatchObject({ exists: true, nextId: 2 })
    expect(json.issues[0]).toMatchObject({ id: 1, title: "First issue", status: "open", body: "" })
    const { data } = await readDisk(repo)
    expect(data.nextId).toBe(2)
  })

  it("400s a first create when docs/ does not exist (never mkdirs into a repo)", async () => {
    const repo = await makeRepo({ file: undefined, docsDir: false })
    const res = await post({ repoRoot: repo, op: { type: "create", title: "Nope" } })
    expect(res?.status).toBe(400)
    expect(((await res?.json()) as { error: string }).error).toContain("docs/")
  })

  it("400s an empty title", async () => {
    const repo = await makeRepo()
    const res = await post({ repoRoot: repo, op: { type: "create", title: "  " } })
    expect(res?.status).toBe(400)
  })

  it("serializes concurrent creates — both land, ids 1 and 2, nextId 3", async () => {
    const repo = await makeRepo({ file: { nextId: 1, issues: [] } })
    const [a, b] = await Promise.all([
      post({ repoRoot: repo, op: { type: "create", title: "First racer" } }),
      post({ repoRoot: repo, op: { type: "create", title: "Second racer" } }),
    ])
    expect(a?.status).toBe(200)
    expect(b?.status).toBe(200)
    const { data } = await readDisk(repo)
    expect(data.nextId).toBe(3)
    expect(data.issues.map((i) => i.id).sort()).toEqual([1, 2])
    expect(data.issues.map((i) => i.title).sort()).toEqual(["First racer", "Second racer"])
  })

  it("serializes a create racing a setStatus — both effects persist", async () => {
    const repo = await makeRepo()
    const [a, b] = await Promise.all([
      post({ repoRoot: repo, op: { type: "create", title: "Racer" } }),
      post({ repoRoot: repo, op: { type: "setStatus", id: 3, status: "hold" } }),
    ])
    expect(a?.status).toBe(200)
    expect(b?.status).toBe(200)
    const { data } = await readDisk(repo)
    expect(data.nextId).toBe(5)
    expect(data.issues.find((i) => i.id === 4)?.title).toBe("Racer")
    expect(data.issues.find((i) => i.id === 3)?.status).toBe("hold")
  })
})

describe("POST /api/issues setStatus", () => {
  it("moves an issue to hold and persists it", async () => {
    const repo = await makeRepo()
    const res = await post({ repoRoot: repo, op: { type: "setStatus", id: 3, status: "hold" } })
    expect(res?.status).toBe(200)
    const json = (await res?.json()) as IssuesState
    expect(json.issues.find((i) => i.id === 3)?.status).toBe("hold")
    const { data } = await readDisk(repo)
    expect(data.issues.find((i) => i.id === 3)?.status).toBe("hold")
    // The other issues are untouched.
    expect(data.issues.find((i) => i.id === 1)?.status).toBe("doing")
  })

  it("404s an unknown id", async () => {
    const repo = await makeRepo()
    const res = await post({ repoRoot: repo, op: { type: "setStatus", id: 99, status: "done" } })
    expect(res?.status).toBe(404)
  })

  it("400s an invalid status", async () => {
    const repo = await makeRepo()
    const res = await post({ repoRoot: repo, op: { type: "setStatus", id: 3, status: "blocked" } })
    expect(res?.status).toBe(400)
  })

  it("400s an unknown op type", async () => {
    const repo = await makeRepo()
    const res = await post({ repoRoot: repo, op: { type: "explode" } })
    expect(res?.status).toBe(400)
  })

  it("400s an invalid JSON body", async () => {
    const url = new URL("http://localhost/api/issues")
    const req = new Request(url, { method: "POST", body: "{not json" })
    const res = await handleIssuesRequest(req, url)
    expect(res?.status).toBe(400)
  })

  it("400s a JSON body of null", async () => {
    const res = await post(null)
    expect(res?.status).toBe(400)
  })
})

describe("POST /api/issues update", () => {
  it("updates title and body and persists them", async () => {
    const repo = await makeRepo()
    const res = await post({
      repoRoot: repo,
      op: { type: "update", id: 1, title: "Fix the flicker for real", body: "new plan" },
    })
    expect(res?.status).toBe(200)
    const json = (await res?.json()) as IssuesState
    const updated = json.issues.find((i) => i.id === 1)
    expect(updated?.title).toBe("Fix the flicker for real")
    expect(updated?.body).toBe("new plan")
    // status + created are untouched by update.
    expect(updated?.status).toBe("doing")
    expect(updated?.created).toBe("2026-05-31")
    const { data } = await readDisk(repo)
    expect(data.issues.find((i) => i.id === 1)?.body).toBe("new plan")
  })

  it("updates title only, leaving body alone", async () => {
    const repo = await makeRepo()
    await post({ repoRoot: repo, op: { type: "update", id: 1, title: "Just the title" } })
    const { data } = await readDisk(repo)
    const issue = data.issues.find((i) => i.id === 1)
    expect(issue?.title).toBe("Just the title")
    expect(issue?.body).toBe("tooltip body")
  })

  it("404s an unknown id", async () => {
    const repo = await makeRepo()
    const res = await post({ repoRoot: repo, op: { type: "update", id: 42, title: "ghost" } })
    expect(res?.status).toBe(404)
  })
})

describe("normalization of hand-edited files", () => {
  const MESSY = {
    nextId: 5,
    issues: [
      { id: 1, title: "No body here", status: "open", created: "2026-06-01" },
      { id: 2, title: "Mystery status", status: "blocked", created: "2026-06-02", body: "x" },
      "not an object",
      { title: "no id, dropped" },
    ],
  }

  it("GET returns normalized entries: defaulted body, unknown status → open, junk skipped", async () => {
    const repo = await makeRepo({ file: MESSY })
    const res = await get(repo)
    expect(res?.status).toBe(200)
    const json = (await res?.json()) as IssuesState
    expect(json.issues).toHaveLength(2)
    expect(json.issues[0]).toEqual({ id: 1, title: "No body here", status: "open", created: "2026-06-01", body: "" })
    expect(json.issues[1]).toEqual({ id: 2, title: "Mystery status", status: "open", created: "2026-06-02", body: "x" })
    // GET never rewrites the file.
    const { text } = await readDisk(repo)
    expect(text).toBe(`${JSON.stringify(MESSY, null, 2)}\n`)
  })

  it("setStatus on a messy file still works and persists normalized data", async () => {
    const repo = await makeRepo({ file: MESSY })
    const res = await post({ repoRoot: repo, op: { type: "setStatus", id: 1, status: "doing" } })
    expect(res?.status).toBe(200)
    const { data } = await readDisk(repo)
    expect(data.issues).toHaveLength(2)
    expect(data.issues.find((i) => i.id === 1)).toMatchObject({ status: "doing", body: "" })
    expect(data.issues.find((i) => i.id === 2)?.status).toBe("open")
  })
})

describe("serialization", () => {
  it("round-trips with 2-space indent and a trailing newline (issues-archive.mjs contract)", async () => {
    const repo = await makeRepo()
    const before = await readDisk(repo)
    await post({ repoRoot: repo, op: { type: "setStatus", id: 3, status: "doing" } })
    const after = await readDisk(repo)
    // Exact serialization: re-stringifying the parsed data reproduces the file.
    expect(after.text).toBe(`${JSON.stringify(after.data, null, 2)}\n`)
    expect(after.text.endsWith("\n")).toBe(true)
    expect(after.text).toContain('  "nextId": 4')
    // Only the one status flipped — the rest of the text is byte-identical.
    expect(after.text).toBe(before.text.replace('"status": "open"', '"status": "doing"'))
  })
})
