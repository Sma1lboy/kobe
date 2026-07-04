/**
 * `kobe doctor` resource section — pure halves only (ps-output parsing +
 * pane-group filtering). Why this matters: #205's memory reports had no
 * hard numbers to triage from; this is the parsing kobe uses to build them.
 */

import { describe, expect, test } from "vitest"
import { paneProcessGroups, parsePsRows } from "../../src/cli/doctor-resources"

describe("parsePsRows", () => {
  test("parses pid/pgid/rss/comm, skipping the header row", () => {
    const output = ["  PID  PGID    RSS COMM", "  501   501   3168 kobe tasks", "  502   501   1536 /bin/sh"].join("\n")
    expect(parsePsRows(output)).toEqual([
      { pid: 501, pgid: 501, rssKb: 3168, comm: "kobe tasks" },
      { pid: 502, pgid: 501, rssKb: 1536, comm: "/bin/sh" },
    ])
  })

  test("ignores blank lines and unparseable rows", () => {
    const output = ["  PID  PGID    RSS COMM", "", "   not a row at all", "  501   501   3168 kobe ops"].join("\n")
    expect(parsePsRows(output)).toEqual([{ pid: 501, pgid: 501, rssKb: 3168, comm: "kobe ops" }])
  })

  test("empty input yields no rows", () => {
    expect(parsePsRows("")).toEqual([])
    expect(parsePsRows("  PID  PGID    RSS COMM")).toEqual([])
  })
})

describe("paneProcessGroups", () => {
  test("keeps only rows whose pgid is one of the given pane pids", () => {
    const rows = [
      { pid: 501, pgid: 501, rssKb: 3168, comm: "kobe tasks" },
      { pid: 610, pgid: 600, rssKb: 9000, comm: "claude" },
      { pid: 1, pgid: 1, rssKb: 9999, comm: "launchd" },
    ]
    expect(paneProcessGroups(rows, [501, 600])).toEqual([rows[0], rows[1]])
  })

  test("no matching pane pids yields no rows", () => {
    const rows = [{ pid: 501, pgid: 501, rssKb: 3168, comm: "kobe tasks" }]
    expect(paneProcessGroups(rows, [999])).toEqual([])
  })
})
