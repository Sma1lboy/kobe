import { afterEach, describe, expect, test } from "bun:test"
import type { TaskPtyLike } from "../../src/tui/panes/terminal/pty-types.ts"
import { BunTerminalTaskPty } from "../../src/tui/panes/terminal/pty.ts"

const children: TaskPtyLike[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

function withOuterTerminalIdentity<T>(run: () => T): T {
  const program = process.env.TERM_PROGRAM
  const version = process.env.TERM_PROGRAM_VERSION
  process.env.TERM_PROGRAM = "iTerm.app"
  process.env.TERM_PROGRAM_VERSION = "3.6.11"
  try {
    return run()
  } finally {
    if (program === undefined) Reflect.deleteProperty(process.env, "TERM_PROGRAM")
    else process.env.TERM_PROGRAM = program
    if (version === undefined) Reflect.deleteProperty(process.env, "TERM_PROGRAM_VERSION")
    else process.env.TERM_PROGRAM_VERSION = version
  }
}

function text(pty: TaskPtyLike): string {
  return pty
    .capture()
    .map((row) => row.map((chunk) => chunk.text).join(""))
    .join("\n")
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error("timeout waiting for child environment")
    await Bun.sleep(20)
  }
}

const command = [
  "/bin/sh",
  "-c",
  'printf "program=%s version=%s\\n" "${TERM_PROGRAM-unset}" "${TERM_PROGRAM_VERSION-unset}"; sleep 1',
]

describe("local Bun PTY child environment", () => {
  test("Bun PTY does not leak the outer terminal emulator identity", async () => {
    const pty = withOuterTerminalIdentity(
      () => new BunTerminalTaskPty({ taskId: "bun-env", cwd: process.cwd(), command, cols: 60, rows: 8 }),
    )
    children.push(pty)

    await until(() => text(pty).includes("program="))
    expect(text(pty)).toContain("program=unset version=unset")
  })
})
