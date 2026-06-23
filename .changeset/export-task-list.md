---
"@sma1lboy/kobe": patch
---

Add `kobe export` to dump the task list to stdout without a running daemon. It reads `~/.kobe/tasks.json` in process and prints JSON (default), CSV (`--csv`), or an aligned table (`--format table`), so you can pipe tasks into `jq`, open them in a spreadsheet, or glance at them in the terminal — complementing `kobe api list`, which is JSON-only and requires the daemon.
