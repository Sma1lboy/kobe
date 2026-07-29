/**
 * `kobe plugin install` / `kobe plugin link` — getting a plugin registered.
 *
 * Install accepts GitHub shorthand only (`owner/repo[/subdir...]`): clone,
 * parse + preview the manifest, confirm (unless --yes), run supported
 * [[build]] commands, then move the checkout under `~/.kobe/plugins/<id>/`
 * and register it. Link registers a local working directory as-is and runs
 * no build — authors build their own tree. Both work with no daemon running;
 * the daemon file-watches the registry and picks changes up live.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import {
  PLUGIN_MANIFEST_FILENAME,
  type ParsedPluginManifest,
  currentPluginPlatform,
  parsePluginManifest,
  supportsPlatform,
} from "@sma1lboy/kobe-daemon/plugins/manifest"
import { pluginCheckoutDir, pluginConfigDir, pluginStateDir } from "@sma1lboy/kobe-daemon/plugins/plugin-paths"
import {
  type PluginRegistryEntry,
  loadPluginRegistry,
  savePluginRegistry,
  upsertPluginEntry,
} from "@sma1lboy/kobe-daemon/plugins/registry"
import { CURRENT_VERSION, compareSemver } from "../version.ts"

const GITHUB_SPEC_RE = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(\/.+)?$/

export class PluginCliError extends Error {}

function fail(message: string): never {
  throw new PluginCliError(message)
}

function readManifestAt(root: string): ParsedPluginManifest {
  const path = join(root, PLUGIN_MANIFEST_FILENAME)
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    fail(`no ${PLUGIN_MANIFEST_FILENAME} found at ${root}`)
  }
  return parsePluginManifest(text)
}

function checkVersionGate(parsed: ParsedPluginManifest): void {
  const min = parsed.manifest.minKobeVersion
  if (compareSemver(CURRENT_VERSION, min) < 0) {
    fail(`plugin requires kobe >= ${min} (this is ${CURRENT_VERSION}); update kobe first`)
  }
}

function printPreview(parsed: ParsedPluginManifest, source: string): void {
  const m = parsed.manifest
  console.log(`\n${m.name} (${m.id}) v${m.version} — ${m.description ?? "no description"}`)
  console.log(`source: ${source}`)
  const show = (label: string, commands: readonly { command: readonly string[] }[]) => {
    for (const c of commands) console.log(`  ${label}: ${c.command.join(" ")}`)
  }
  show("build", m.build)
  show("startup", m.startup)
  for (const a of m.actions) console.log(`  action ${a.id}: ${a.command.join(" ")}`)
  for (const e of m.events) console.log(`  on ${e.on}: ${e.command.join(" ")}`)
  for (const w of parsed.warnings) console.log(`  warning: ${w}`)
  console.log("")
}

async function confirmOrBail(yes: boolean): Promise<void> {
  if (yes) return
  if (!process.stdin.isTTY) {
    fail("refusing to install without confirmation in a non-interactive terminal; pass --yes")
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question("Install this plugin and run its build commands? [y/N] ")).trim().toLowerCase()
  rl.close()
  if (answer !== "y" && answer !== "yes") fail("aborted")
}

function git(args: string[], cwd?: string): void {
  const res = spawnSync("git", args, { cwd, stdio: ["ignore", "inherit", "inherit"] })
  if (res.status !== 0) fail(`git ${args[0]} failed`)
}

function runBuildCommands(parsed: ParsedPluginManifest, root: string): void {
  const platform = currentPluginPlatform()
  for (const [i, step] of parsed.manifest.build.entries()) {
    if (!supportsPlatform(step, parsed.manifest, platform)) continue
    const [cmd, ...args] = step.command
    console.log(`build[${i}]: ${step.command.join(" ")}`)
    const res = spawnSync(cmd as string, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] })
    if (res.status !== 0) fail(`build[${i}] failed (exit ${res.status ?? "spawn error"}); plugin not registered`)
  }
}

function register(entry: PluginRegistryEntry): void {
  savePluginRegistry(upsertPluginEntry(loadPluginRegistry(), entry))
  mkdirSync(pluginConfigDir(entry.id), { recursive: true })
  mkdirSync(pluginStateDir(entry.id), { recursive: true })
}

/** Installs and returns the plugin id the manifest declared. */
export async function installPlugin(spec: string, opts: { yes: boolean; ref?: string }): Promise<string> {
  const match = spec.match(GITHUB_SPEC_RE)
  if (!match) fail(`install takes GitHub shorthand (owner/repo[/subdir]), got \`${spec}\``)
  const [, owner, repo, subdirRaw] = match
  const subdir = subdirRaw?.replace(/^\//, "")

  const tmp = mkdtempSync(join(tmpdir(), "kobe-plugin-"))
  try {
    const url = `https://github.com/${owner}/${repo}.git`
    console.log(`cloning ${url}${opts.ref ? ` @ ${opts.ref}` : ""}`)
    if (opts.ref) {
      git(["clone", "--quiet", url, tmp])
      git(["checkout", "--quiet", opts.ref], tmp)
    } else {
      git(["clone", "--quiet", "--depth", "1", url, tmp])
    }
    const rootInClone = subdir ? join(tmp, subdir) : tmp
    const parsed = readManifestAt(rootInClone)
    checkVersionGate(parsed)
    const id = parsed.manifest.id

    const existing = loadPluginRegistry().plugins.find((p) => p.id === id)
    if (existing?.source.kind === "link") {
      fail(`\`${id}\` is locally linked at ${existing.root}; unlink it first`)
    }
    if (!supportsPlatform({}, parsed.manifest, currentPluginPlatform())) {
      fail(`plugin declares platforms [${parsed.manifest.platforms?.join(", ")}]; this machine is unsupported`)
    }

    printPreview(parsed, `github.com/${owner}/${repo}${subdir ? `/${subdir}` : ""}`)
    await confirmOrBail(opts.yes)
    runBuildCommands(parsed, rootInClone)

    // Re-read after build: a build that rewrites the manifest voids the preview.
    const after = readFileSync(join(rootInClone, PLUGIN_MANIFEST_FILENAME), "utf8")
    if (parsePluginManifest(after).manifest.id !== id) fail("manifest changed during build; aborting")

    const checkout = pluginCheckoutDir(id)
    rmSync(checkout, { recursive: true, force: true })
    mkdirSync(join(checkout, ".."), { recursive: true })
    renameSync(tmp, checkout)
    register({
      id,
      source: { kind: "github", spec },
      root: subdir ? join(checkout, subdir) : checkout,
      enabled: true,
      version: parsed.manifest.version,
      installedAt: Date.now(),
    })
    console.log(`installed ${id} v${parsed.manifest.version}`)
    return id
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export function linkPlugin(dir: string): void {
  const root = resolve(dir)
  if (!existsSync(root)) fail(`no such directory: ${root}`)
  const parsed = readManifestAt(root)
  checkVersionGate(parsed)
  const id = parsed.manifest.id
  const existing = loadPluginRegistry().plugins.find((p) => p.id === id)
  if (existing?.source.kind === "github") {
    fail(`\`${id}\` is installed from GitHub; uninstall it before linking a local copy`)
  }
  for (const w of parsed.warnings) console.log(`warning: ${w}`)
  register({
    id,
    source: { kind: "link" },
    root,
    enabled: true,
    version: parsed.manifest.version,
    installedAt: Date.now(),
  })
  console.log(`linked ${id} v${parsed.manifest.version} → ${root}`)
}
