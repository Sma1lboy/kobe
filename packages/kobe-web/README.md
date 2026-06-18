# kobe-web

The local browser dashboard for kobe — a terminal-native workspace for running
many AI coding sessions at once, in the browser. Full architecture (process
model, daemon channels, route table) lives in
[`docs/design/web-dashboard.md`](../../docs/design/web-dashboard.md).

## Three processes

`node-pty` doesn't work under Bun, and a web crash must never take the daemon
down — so the dashboard is split into three cooperating processes:

- **SPA** — React + TanStack Router, served by Vite in dev (`:5173`).
- **Bridge** (`server/`) — a standalone Bun HTTP/SSE server (`:5174`) that holds
  ONE daemon socket (`role: "gui"`) and fronts it. NOT daemon-hosted: it
  restarts independently and a bug here can't hurt the daemon.
- **PTY sidecar** (`pty-server.mjs`) — a node process (`:5175`) running each
  engine/terminal tab's PTY.

## Develop

```bash
bun run dev            # all three processes; opens http://localhost:5173
bun run dev:sandbox    # same, but pointed at a throwaway KOBE_HOME_DIR + the
                       # kobe-sandbox tmux socket — never touches production
                       # ~/.kobe/tasks.json
```

`bun run dev` connects to your **production** `~/.kobe` daemon — the startup
banner says which home it's wired to. Use `dev:sandbox` when you don't want to
mutate real tasks.

## Test, lint, build

```bash
bun run test    # vitest — touches NO daemon (fake links / pure helpers); safe anytime
bun run check   # biome lint + format (gate this by exit code)
bun run build   # vite build → dist/ (what `kobe web` serves in production)
```

The repo-root `bun run lint` does NOT cover this package — run `bun run check`
here.

## Production

The default `@sma1lboy/kobe` package is TUI-first and does not bundle this web
dashboard. Source checkouts should use `bun run dev` / `bun run dev:sandbox`.
A future web-enabled distribution can still run `kobe web`: it runs the bridge
in-process, serves the built SPA from the packaged `dist/web-ui`, and spawns
the PTY sidecar on `port + 2`:

```bash
kobe web                 # http://localhost:5173
kobe web --port 5180
```

## What it does

- **Left rail** — live tasks from the daemon (sort, filter, `j`/`k` nav, change
  chips, PR/activity, archived restore). New Task + Adopt-worktree dialogs.
- **Center** — per-task workspace tabs (client-owned, localStorage): engine PTY
  (with a prompt composer + reattach), shell PTY, structured Chat transcript,
  and diff file previews.
- **Right** — task metadata (rename/branch/status/vendor/pin/archive/delete),
  a markdown notes scratchpad (with preview), and a live Changes/diff rail.
- **More** — command palette (Cmd/Ctrl+K), `?` keyboard help, an Overview
  triage route (`/overview`), deep links (`/task/:id`), live theme sync + a
  Settings theme picker, desktop notifications, and a root error boundary.
