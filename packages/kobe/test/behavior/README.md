# Behavior tests

> Tests that **run the kobe binary** and assert on what the user sees.
> Required for every stream that ships user-visible behavior. See
> [`docs/HARNESS.md`](../../docs/HARNESS.md) §"Behavioral self-test".

## Run

```bash
bun run test:behavior          # run every test/behavior/**/*.test.ts
bun run test:behavior --watch  # iterate
```

## Author a behavior test in 5 minutes

1. Create `test/behavior/<feature>.test.ts`.
2. Spawn kobe, drive it, assert, exit.

```ts
import { afterEach, expect, test } from "vitest"
import { spawnKobe, type KobeHandle } from "./driver"

let kobe: KobeHandle | null = null
afterEach(async () => {
  if (kobe && !kobe.closed) await kobe.exit()
  kobe = null
})

test("creating a task shows it in the sidebar", async () => {
  kobe = await spawnKobe()                       // bun + opentui under a pty
  await kobe.waitFor((s) => s.includes("kobe"))  // wait for first paint
  await kobe.sendKeys("\x0e")                    // ctrl+n — open new-task dialog
  await kobe.typeText("test task")
  await kobe.sendKeys("\r")                      // submit
  const screen = await kobe.waitFor((s) => s.includes("test task"))
  expect(screen).toContain("In progress")
}, 20_000)                                       // generous test timeout
```

## API surface

`spawnKobe(opts?)` returns a `KobeHandle`:

| Method | Purpose |
| --- | --- |
| `sendKeys(seq)` | Write raw bytes to the pty. Use for control codes (`"\r"`, `"\x1b"`, arrows: `"\x1b[A"`). |
| `typeText(s)` | Convenience wrapper for printable text. |
| `capture()` | Plain-text snapshot of the visible screen. ANSI stripped, normalized. |
| `captureRaw()` | Same buffer with ANSI intact (rarely needed). |
| `waitFor(fn, ms?)` | Poll `capture()` until `fn(screen)` is true. Throws on timeout, including the last screen in the message. |
| `resize(cols, rows)` | Send a SIGWINCH-equivalent. |
| `exit()` | SIGTERM, then SIGKILL after a grace period. Idempotent. Always call this in `afterEach`. |
| `closed`, `exitCode` | Status fields for assertions. |

`spawnKobe` options (all optional):

```ts
{
  cwd?: string                   // defaults to repo root
  command?: string               // defaults to `bun`
  args?: string[]                // defaults to bun argv for src/cli/index.ts
  cols?: number                  // default 80
  rows?: number                  // default 24
  env?: Record<string, string>   // merged on top of process.env
  settleMs?: number              // delay after sendKeys; default 100
}
```

## Faking the AI engine

`FakeAIEngine` from `./fake-engine` implements `AIEngine` (DESIGN.md §5.2)
deterministically. Use it any time a behavior test would otherwise
spawn a real `claude` CLI:

```ts
import { FakeAIEngine } from "./fake-engine"
const engine = new FakeAIEngine()
engine.script("session-1", [
  { type: "assistant.delta", text: "Hello!" },
  { type: "done" },
])
engine.setHistory("session-1", [
  { role: "user", content: "hi", ts: "..." },
])
```

Wave 1's Stream A will land the real `ClaudeCodeLocal` engine; until
then, behavior tests that need an engine should pass a `FakeAIEngine`
through whatever DI seam exists (or via env, e.g. `KOBE_FAKE_ENGINE=1`).

## Fixtures

`fixtures/repo-init.sh` builds a tiny throwaway git repo at the path
you pass. Use it for streams that need a real worktree:

```ts
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "kobe-"))
const repo = execFileSync("test/behavior/fixtures/repo-init.sh", [tmp], {
  encoding: "utf8",
}).trim()
// repo is the path to a clean git repo with one commit on `main`.
```

## Common pitfalls

- **"My screen is empty in the assertion."** The TUI repaints async.
  Use `waitFor()` instead of `capture()` for first assertions; raise
  the timeout for slow CI. Never `setTimeout` + assert.

- **"My test passes locally and times out in CI."** Default settle
  time is 100ms. If kobe spawned a heavier subtree (engine, worktree
  manager), bump `settleMs` to ~250ms via `spawnKobe({ settleMs: 250 })`.

- **"Special characters fail to match."** kobe uses Unicode glyphs
  (em-dashes, box-drawing chars). Pin `toContain` to ASCII tokens that
  are robust to title or icon changes.

- **"My pty is leaking between tests."** Always `await kobe.exit()` in
  `afterEach`. The driver tears down with SIGTERM → SIGKILL, but a
  test that throws before reaching `exit()` will orphan the process
  unless `afterEach` catches it.

- **"`posix_spawnp failed` on first run after `bun install`."** The
  driver auto-fixes this (it `chmod +x`s `node-pty`'s prebuilt
  spawn-helper on first spawn). If you see it anyway, run
  `chmod +x node_modules/node-pty/prebuilds/$(node -e 'console.log(`${process.platform}-${process.arch}`)')/spawn-helper`
  manually and file an issue against the harness.

- **"Why does the driver run under Node when the project uses Bun?"**
  Vitest's bin is a Node shim, and `node-pty` doesn't fire its
  `onData` callback under Bun (as of Bun 1.3.x). The kobe binary is
  still spawned via `bun`; only the driver itself runs under Node.

- **"My test asserts on a status string that the driver shows in
  ANSI."** Don't. The screen is normalized to plain text. If you
  truly need ANSI, `captureRaw()` exists — but prefer keeping
  assertions ANSI-free.
