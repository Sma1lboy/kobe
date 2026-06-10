/**
 * `kobe add --remote …` — register an SSH-backed project.
 *
 * Stores the connection config under `remoteRepos[ssh://user@host:port]` and
 * adds that synthetic key to `savedRepos`. For password auth the secret is
 * prompted interactively (never on argv) and written to the OS keychain — only
 * a `keychainRef` lands in `state.json`. A best-effort connectivity probe runs
 * after registration so a typo surfaces immediately, but a failed probe does
 * NOT unregister the project (the host may just be down right now).
 *
 * See `docs/design/remote-projects.md`.
 */

import { createInterface } from "node:readline"
import { remoteControlSocketPath } from "../env.ts"
import { RemoteExecHost, type RemoteSpec } from "../exec/exec-host.ts"
import { getKeychainPassword, isKeychainSupported, remoteKeychainRef, setKeychainPassword } from "../exec/keychain.ts"
import { addRemoteRepo, isRemoteProjectsEnabled } from "../state/repos.ts"

export interface ParsedFlags {
  host?: string
  user?: string
  path?: string
  port?: number
  key?: { present: true; path?: string }
  password?: true
}

const USAGE =
  "Usage: kobe add --remote --host <host> --user <user> --path <basePath>\n" +
  "                [--port N] [--key [path] | --password]\n\n" +
  "Register an SSH-backed project. Worktrees + the engine run on <host> under\n" +
  "<basePath>. Choose ONE auth: --key [path] (ssh-agent when path omitted) or\n" +
  "--password (prompted, stored in the OS keychain — never in state.json).\n"

export function parseRemoteFlags(args: readonly string[]): ParsedFlags {
  const f: ParsedFlags = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    switch (a) {
      case "--host":
        f.host = args[++i]
        break
      case "--user":
        f.user = args[++i]
        break
      case "--path":
        f.path = args[++i]
        break
      case "--port": {
        const n = Number(args[++i])
        if (!Number.isInteger(n) || n <= 0) fail(`invalid --port "${args[i]}"`)
        f.port = n
        break
      }
      case "--key": {
        // Optional path: a following non-flag token is the key path; otherwise ssh-agent.
        const next = args[i + 1]
        if (next && !next.startsWith("-")) {
          f.key = { present: true, path: next }
          i++
        } else {
          f.key = { present: true }
        }
        break
      }
      case "--password":
        f.password = true
        break
      case "--help":
      case "-h":
        process.stdout.write(USAGE)
        process.exit(0)
        break
      default:
        fail(`unknown flag "${a}"`)
    }
  }
  return f
}

function fail(msg: string): never {
  process.stderr.write(`kobe add --remote: ${msg}\n\n${USAGE}`)
  process.exit(2)
}

/** Read a line from the tty with echo suppressed (for the SSH password). */
async function promptHidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const out = process.stdout as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void }
  // Mask everything readline would echo after the prompt is printed.
  let muted = false
  const original = out._writeToOutput?.bind(out)
  out._writeToOutput = (s: string) => {
    if (!muted || !original) process.stdout.write(s)
  }
  process.stdout.write(prompt)
  muted = true
  return new Promise((res) => {
    rl.question("", (answer) => {
      muted = false
      if (original) out._writeToOutput = original
      process.stdout.write("\n")
      rl.close()
      res(answer)
    })
  })
}

export async function runAddRemote(args: readonly string[]): Promise<void> {
  if (!isRemoteProjectsEnabled()) {
    fail("remote projects are experimental and disabled — enable Settings → Dev → Experimental → Remote projects first")
  }
  const f = parseRemoteFlags(args)
  if (!f.host) fail("--host is required")
  if (!f.user) fail("--user is required")
  if (!f.path) fail("--path (remote base path) is required")
  if (f.key && f.password) fail("choose ONE of --key or --password, not both")
  if (!f.key && !f.password) fail("an auth method is required: --key [path] or --password")

  // Resolve auth: store the password in the keychain now; persist only a ref.
  let auth: Parameters<typeof addRemoteRepo>[0]["auth"]
  if (f.password) {
    if (!isKeychainSupported()) fail("--password needs the macOS keychain (unsupported on this platform)")
    const ref = remoteKeychainRef(f.host, f.user, f.port)
    const pw = await promptHidden(`Password for ${f.user}@${f.host}: `)
    if (pw.length === 0) fail("empty password")
    if (!setKeychainPassword(ref, pw)) fail("failed to store the password in the keychain")
    auth = { kind: "password", keychainRef: ref }
  } else {
    auth = { kind: "key", keyPath: f.key?.path }
  }

  const { key, added } = addRemoteRepo({ host: f.host, user: f.user, port: f.port, basePath: f.path, auth })
  console.log(added ? `added remote project ${key} (base ${f.path})` : `updated remote project ${key} (base ${f.path})`)

  await probe(f, auth)
}

/** Best-effort reachability check: open the control master + list the base path. */
async function probe(f: ParsedFlags, auth: Parameters<typeof addRemoteRepo>[0]["auth"]): Promise<void> {
  if (auth.kind === "password" && !isKeychainSupported()) return
  const runtimeAuth: RemoteSpec["auth"] =
    auth.kind === "key"
      ? { kind: "key", keyPath: auth.keyPath }
      : { kind: "password", getPassword: () => getKeychainPassword(auth.keychainRef) }
  const spec: RemoteSpec = {
    host: f.host!,
    user: f.user!,
    port: f.port,
    auth: runtimeAuth,
    controlPath: remoteControlSocketPath(f.host!, f.user!, f.port),
  }
  process.stdout.write("checking connection… ")
  try {
    const host = new RemoteExecHost(spec)
    const r = await host.run(["test", "-d", f.path!])
    if (r.exitCode === 0) console.log("ok")
    else console.log(`reachable, but base path "${f.path}" is not a directory (you can create it later)`)
  } catch (err) {
    console.log(`could not connect (${err instanceof Error ? err.message : String(err)})`)
    console.log("the project is saved; fix the host/credentials and it will connect on first use.")
  }
}
