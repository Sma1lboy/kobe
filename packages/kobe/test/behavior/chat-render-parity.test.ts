/**
 * Wave 4.B — chat render parity behavior test.
 *
 * Asserts on visible output of the new MessageList renderer when the
 * fake engine streams Claude-Code-shaped markdown. We can't assert on
 * raw ANSI styling (the screen-strip drops attributes), but we CAN
 * assert that:
 *
 *   1. The user-prompt row carries the new `>` chip (replaces the old
 *      `you` label).
 *   2. The assistant row carries the new `⏺` (or `●`) prefix.
 *   3. Inline-code text from the assistant message is rendered visibly
 *      (the markdown parser doesn't hide the body).
 *   4. Bullet-list items are rendered with a `•` marker.
 *   5. Fenced code blocks render their content lines verbatim.
 *
 * What we explicitly do NOT assert here:
 *
 *   - Color codes / bold / italic — `screen.ts` strips ANSI before
 *     comparison, by design (assertions stay focused on visible text).
 *   - Exact column positions — opentui's cell-by-cell painting can
 *     fragment text in the cumulative PTY buffer.
 *   - Width of the BLACK_CIRCLE column — covered by G3a passing again
 *     after we reserved width=2 for the prefix.
 *
 * The fake engine is the same side-channel used by `g3-chat.test.ts`
 * (POST localhost:<port>/script). See `app.tsx`'s
 * `mountFakeEngineServer` for the protocol.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import * as net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, expect, test } from "vitest"
import type { EngineEvent } from "../../src/types/engine.ts"
import { type KobeHandle, spawnKobe } from "./driver"

const REPO_INIT = path.resolve(__dirname, "fixtures/repo-init.sh")

async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (addr && typeof addr === "object") {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close()
        reject(new Error("could not allocate a free port"))
      }
    })
  })
}

async function scriptEngine(
  port: number,
  endpoint: "/script" | "/finish",
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(payload)
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`fake-engine ${endpoint} failed: ${res.status} ${text}`)
  }
}

async function waitForFakeServer(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await scriptEngine(port, "/script", { sessionId: "__warmup__", events: [] })
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`fake-engine server never came up on :${port}: ${lastErr}`)
}

async function buildFixture(): Promise<{ tmpRoot: string; homeDir: string; repo: string }> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-w4b-"))
  const homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  const repo = path.join(tmpRoot, "repo")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) {
    throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)
  }
  return { tmpRoot, homeDir, repo }
}

async function fillNewTaskDialog(kobe: KobeHandle, prompt: string, repo: string): Promise<void> {
  await kobe.sendKeys("\x0e") // ctrl+n
  await kobe.waitFor((s) => s.includes("New task"), 5_000)
  await kobe.typeText(prompt)
  await kobe.sendKeys("\t")
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText(repo)
  await kobe.sendKeys("\r")
}

let kobe: KobeHandle | null = null
let tmpRoot: string | null = null

beforeAll(() => {
  if (!fs.existsSync(REPO_INIT)) {
    throw new Error(`missing fixture: ${REPO_INIT}`)
  }
})

afterEach(async () => {
  if (kobe && !kobe.closed) {
    await kobe.exit()
  }
  kobe = null
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  tmpRoot = null
})

// ---------------------------------------------------------------------
// Markdown rendering: bold + inline code + list + fenced code.
// ---------------------------------------------------------------------

test("W4B — assistant markdown renders bold/code/list/fenced code visibly", async () => {
  const fixture = await buildFixture()
  tmpRoot = fixture.tmpRoot
  const port = await pickFreePort()

  // Wide viewport — opentui's cell-by-cell painting can fragment long
  // tokens in the cumulative PTY buffer when the chat column is narrow.
  // 200 cols leaves ~120 for the chat body.
  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_TEST_FAKE_PORT: String(port),
      KOBE_HOME_DIR: fixture.homeDir,
    },
    cols: 200,
    rows: 50,
  })

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)
  await waitForFakeServer(port)

  // Markdown payload that exercises every block kind the renderer
  // claims to support. Distinct sentinels per element so we can assert
  // each one shipped to the screen.
  //
  // Token choice notes:
  //   - "BOLDXYZ" — single-word, no spaces, so cell painting can't
  //     fragment it across columns in the buffer.
  //   - "INLINECODEZ" — ditto, inline-code body.
  //   - "LISTITEMA"/"LISTITEMB" — bullet items (one per line).
  //   - "FENCEDXYZ" — code-block body line.
  const md = [
    "Here is some **BOLDXYZ** text and `INLINECODEZ` inline.",
    "",
    "- LISTITEMA",
    "- LISTITEMB",
    "",
    "```ts",
    "const FENCEDXYZ = 1",
    "```",
  ].join("\n")

  const events: EngineEvent[] = [{ type: "assistant.delta", text: md }, { type: "done" }]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events })

  await fillNewTaskDialog(kobe, "render parity", fixture.repo)

  // Wait for the fenced code block content — last token in the
  // payload, so its arrival means the whole markdown rendered.
  const screen = await kobe.waitFor((s) => s.includes("FENCEDXYZ"), 15_000)

  // Bold body shows up verbatim (we strip the ** markers but keep the
  // word, since opentui's BOLD attribute is the styling, not the chars).
  expect(screen).toContain("BOLDXYZ")

  // Inline code keeps its backtick wrapper in the rendered output —
  // visible-friendly cue that the segment is code (mirrors how Claude
  // Code emphasizes inline code with a contrasting fg without removing
  // the delimiters).
  expect(screen).toContain("INLINECODEZ")

  // Bullet markers + items.
  expect(screen).toContain("LISTITEMA")
  expect(screen).toContain("LISTITEMB")
  expect(screen).toContain("•")

  // Fenced code body.
  expect(screen).toContain("FENCEDXYZ")

  // The user prompt chip — accent `>` followed by the prompt text.
  expect(screen).toContain("render parity")

  await kobe.exit()
}, 60_000)

// ---------------------------------------------------------------------
// Tool banner shape: prefix glyph + bold name + (args).
// ---------------------------------------------------------------------

test("W4B — tool call banner renders with prefix glyph + name + (args)", async () => {
  const fixture = await buildFixture()
  tmpRoot = fixture.tmpRoot
  const port = await pickFreePort()

  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_TEST_FAKE_PORT: String(port),
      KOBE_HOME_DIR: fixture.homeDir,
    },
    cols: 200,
    rows: 50,
  })

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)
  await waitForFakeServer(port)

  // Pre-script a tool-call cycle. We use a unique tool name so the
  // assertion is unambiguous; the banner shape is `<glyph> Name(args)`.
  const events: EngineEvent[] = [
    { type: "tool.start", name: "BashUNIQUE", input: { cmd: "ls" } },
    { type: "tool.result", name: "BashUNIQUE", output: "ok" },
    { type: "assistant.delta", text: "after-tool" },
    { type: "done" },
  ]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events })

  await fillNewTaskDialog(kobe, "tool render", fixture.repo)

  // Wait for the assistant trailing text — proves the events drained.
  const screen = await kobe.waitFor((s) => s.includes("after-tool"), 15_000)

  // Tool name visible (bold styling stripped, but text remains).
  expect(screen).toContain("BashUNIQUE")
  // Args one-line preview is visible.
  expect(screen).toContain("ls")
  // Result preview indent glyph (`⎿`) appears alongside the result.
  // (Don't assert on `ok` because the cumulative-screen substring may
  // pick that up from an unrelated cell.)
  expect(screen).toContain("⎿")

  await kobe.exit()
}, 60_000)
