#!/usr/bin/env node
// Move resolved issues out of the active backlog into the archive.
//
//   bun scripts/issues-archive.mjs        # archive every status === "done"
//
// Keeps docs/issues.json small (the conflict + read surface) while preserving
// closed work in docs/issues-archive.json. `nextId` stays on the active file
// so ids never get reused. Idempotent: a run with nothing done is a no-op.
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const docs = join(dirname(dirname(fileURLToPath(import.meta.url))), "docs")
const activePath = join(docs, "issues.json")
const archivePath = join(docs, "issues-archive.json")

const active = JSON.parse(readFileSync(activePath, "utf8"))
const archive = JSON.parse(readFileSync(archivePath, "utf8"))

const done = active.issues.filter((i) => i.status === "done")
if (done.length === 0) {
  console.log("No done issues to archive.")
  process.exit(0)
}

active.issues = active.issues.filter((i) => i.status !== "done")
// Newest-archived first so the archive reads most-recent-on-top.
archive.issues = [...done, ...archive.issues]

writeFileSync(activePath, `${JSON.stringify(active, null, 2)}\n`)
writeFileSync(archivePath, `${JSON.stringify(archive, null, 2)}\n`)
console.log(`Archived ${done.length} issue(s): ${done.map((i) => `#${i.id}`).join(", ")}`)
