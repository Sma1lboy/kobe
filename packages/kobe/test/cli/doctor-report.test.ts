import { describe, expect, it } from "vitest"
import { buildReportBundle, reportEnvLines } from "../../src/cli/doctor-report.ts"

describe("buildReportBundle", () => {
  const bundle = buildReportBundle(["kobe doctor", "  build:  v1.2.3"], {
    generatedAt: "2026-07-15T00:00:00.000Z",
    env: { KOBE_HOME_DIR: "/tmp/home", TERM: "xterm", SECRET_TOKEN: "hunter2" },
    daemonLog: "daemon line",
    ptyLog: "",
  })

  it("embeds the diagnosis lines and section headers", () => {
    expect(bundle).toContain("## diagnosis")
    expect(bundle).toContain("  build:  v1.2.3")
    expect(bundle).toContain("generated: 2026-07-15T00:00:00.000Z")
  })

  it("includes log tails, falling back when a log is empty", () => {
    expect(bundle).toContain("daemon line")
    expect(bundle).toContain("## pty-host.log (last 200 lines)\n(empty or absent)")
  })

  it("captures KOBE_* + known env keys but never arbitrary secrets", () => {
    const lines = reportEnvLines({ KOBE_HOME_DIR: "/tmp/home", TERM: "xterm", SECRET_TOKEN: "hunter2" })
    expect(lines).toContain("KOBE_HOME_DIR=/tmp/home")
    expect(lines).toContain("TERM=xterm")
    expect(lines.some((l) => l.startsWith("SECRET_TOKEN"))).toBe(false)
  })
})
