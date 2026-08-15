#!/usr/bin/env bun
// Changeset frontmatter validator — the LOCAL, pre-commit half of the
// changeset gates. CI already rejects a bad package name
// (test/architecture/package-distribution.test.ts) and a missing changeset
// (ci.yml's changeset-cap), but both only speak up after a push, and the
// package-name check fails inside `typecheck-and-test` — which means a bad
// changeset that reaches main turns main AND every branch cut from it red
// until someone fixes it. That happened: PR #445 shipped
// `"@sma1lboy/kobe": patch` (the pre-2026-08-13 canonical name), and main
// stayed red across several commits until #446 retargeted the one line.
//
// So this runs at commit time, where the author is still holding the
// context, and costs milliseconds. It is not a replacement for the CI
// checks — a hook is trivially bypassed (`--no-verify`) and only exists on
// machines that ran `bun run hooks:install`. It is the fast feedback path.
//
// Usage:
//   bun scripts/check-changeset.mjs           # every .changeset/*.md
//   bun scripts/check-changeset.mjs a.md b.md # only these (pre-commit passes staged paths)

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, basename } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const DIR = join(ROOT, ".changeset")

/**
 * Publishable workspace packages a changeset may version, read from the
 * workspace itself rather than hard-coded — the 2026-08-13 rename
 * (`@sma1lboy/kobe` → `@sma1lboy/rove`) is exactly the kind of change a
 * hard-coded list would have gone stale against, which is how the stale
 * name survived long enough to reach main in the first place.
 */
function publishablePackages() {
  const names = []
  for (const dir of readdirSync(join(ROOT, "packages"))) {
    const manifest = join(ROOT, "packages", dir, "package.json")
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, "utf8"))
    if (pkg.private === true || typeof pkg.name !== "string") continue
    names.push(pkg.name)
  }
  return names
}

/**
 * The compatibility aliases that are still published (so they LOOK valid)
 * but must not be what a changeset versions. Keyed to the canonical name a
 * stale changeset meant. Purely for the error message — the rejection above
 * is driven by the live workspace manifests, not by this map, so forgetting
 * to extend it makes the message vaguer, never the check weaker.
 */
const RENAMED = new Map([
  ["@sma1lboy/kobe", "@sma1lboy/rove"],
  ["@sma1lboy/kobe-plugin-sdk", "@sma1lboy/rove-plugin-sdk"],
])

function renameHint(pkg, allowed) {
  const canonical = RENAMED.get(pkg)
  if (canonical && allowed.includes(canonical)) {
    return ` — that is the pre-2026-08-13 compatibility alias; use "${canonical}" (it still publishes alongside)`
  }
  return ""
}

const problems = []

function check(file) {
  const path = file.includes("/") ? join(ROOT, file) : join(DIR, file)
  const name = basename(path)
  if (name === "README.md" || !name.endsWith(".md")) return
  if (!existsSync(path)) return // deleted in this commit
  const source = readFileSync(path, "utf8")

  // Frontmatter must be the canonical Changesets form. The `packages:` /
  // `bump:` variant parses nowhere and only throws at release time
  // (`invalid release type for package "packages"`) — seen 2026-06-26,
  // fixed mid-release twice.
  const fm = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!fm) {
    problems.push(`${name}: no --- frontmatter block`)
    return
  }
  const body = fm[1]
  if (/^\s*(packages:|bump:)/m.test(body)) {
    problems.push(`${name}: uses the invalid "packages:/bump:" form — write '"<pkg>": patch' instead`)
    return
  }

  const entries = [...body.matchAll(/^"([^"]+)":\s*(\S+)/gm)]
  if (entries.length === 0) {
    problems.push(`${name}: frontmatter names no package — expected '"<pkg>": patch'`)
    return
  }
  const allowed = publishablePackages()
  for (const [, pkg, bump] of entries) {
    if (!allowed.includes(pkg)) {
      problems.push(
        `${name}: "${pkg}" is not a publishable workspace package${renameHint(pkg, allowed)}` +
          `\n    publishable: ${allowed.join(", ")}`,
      )
    }
    if (!["patch", "minor", "major"].includes(bump.replace(/^["']|["']$/g, ""))) {
      problems.push(`${name}: bump "${bump}" is not patch/minor/major`)
    }
  }
}

const args = process.argv.slice(2)
const files = args.length > 0 ? args : readdirSync(DIR)
for (const file of files) check(file)

if (problems.length > 0) {
  console.error("changeset check failed:\n")
  for (const p of problems) console.error(`  ${p}`)
  console.error("\nSee docs/RELEASING.md. This same check runs in CI as")
  console.error("test/architecture/package-distribution.test.ts — fixing it after a merge")
  console.error("means main is red for everyone until you do.")
  process.exit(1)
}
