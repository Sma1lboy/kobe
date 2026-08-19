#!/usr/bin/env node
/**
 * The `rove` / `kobe` bin, as published.
 *
 * Installers disagree about which runtime starts a bin file: `bun install -g`
 * symlinks it (Bun runs it), `npm install -g` and `npx` hand it to node. This
 * launcher works under both — under Bun it just imports the real entry, under
 * node it finds a Bun runtime and re-execs through it, and when there is no
 * Bun at all it offers to install one instead of dying with
 * `env: bun: No such file or directory`.
 *
 * Built with `target: "node"` and copied to `dist/cli/rove.js` and
 * `dist/cli/kobe.js`; the Bun bundles it fronts are `<name>-run.js` beside it
 * (see scripts/build.ts). It must never import Bun-only code at load time.
 */

import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"
import {
  canOfferBunInstall,
  installBun,
  launcherDirOf,
  launcherNameOf,
  missingBunMessage,
  relaunchWithBun,
  resolveBunBinary,
} from "./bun-runtime.ts"

const launcherDir = launcherDirOf(import.meta.url)
const cliName = launcherNameOf(import.meta.url)
const entry = join(launcherDir, `${cliName}-run.js`)

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(question)).trim().toLowerCase()
    return answer === "" || answer === "y" || answer === "yes"
  } finally {
    rl.close()
  }
}

async function bunForRelaunch(): Promise<string | null> {
  const lookup = { launcherDir }
  const found = resolveBunBinary(lookup)
  if (found) return found
  if (!canOfferBunInstall()) return null
  const prompt = `${cliName}: Rove runs on the Bun runtime, and none is installed. Install Bun now? [Y/n] `
  if (!(await confirm(prompt))) return null
  return installBun(lookup)
}

if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
  // Already under Bun (`bun install -g`, `bunx`, the daemon re-spawning the
  // CLI with process.execPath): load the real entry in-process, no relaunch.
  await import(pathToFileURL(entry).href)
} else {
  const bun = await bunForRelaunch()
  if (!bun) {
    process.stderr.write(missingBunMessage(cliName))
    process.exit(1)
  }
  process.exit(relaunchWithBun(bun, entry, process.argv.slice(2)))
}
