# The TUI

A tour of the interface beyond the three panes: what the sidebar's status
glyphs mean, where the Inbox fits, the pages behind `ctrl+a` `1`/`2`/`3`,
and what changes when the terminal gets narrow.

This page explains what the features are *for*. The key tables live in
[Keybindings](KEYBINDINGS.md); the mental model behind tasks and sessions
lives in [Concepts](CONCEPTS.md).

## Status glyphs in the sidebar

Task rows carry the branch name, pin marker, PR chip, and `±` change counts.
Session state belongs to the chat tab that runs it, so the status glyph sits
on the **tab rows** underneath:

| Glyph | Meaning |
|---|---|
| spinner | Engine is working (also shown while a worktree materializes or deletes) |
| `?` | Needs your input — a permission prompt or a question |
| `●` | Turn finished, and you haven't looked yet |
| `○` | Idle — nothing pending. Includes a finished turn you've already seen |
| `◌` | Unknown — the daemon has no signal for this tab yet (it just started, or the session's lineage is gone) |
| `◷` | Rate limited |
| `✕` | Error |
| `·` | Not an agent tab (shell or command), or an engine without activity tracking |

**Seen means consumed.** A `●` clears the moment you actually open that tab —
select the task, with that tab active. Moving the sidebar cursor over the row
doesn't count. Once seen, the badge drops back to `○`; there is no lingering
checkmark. Seen state lives in the running TUI only, so a fresh attach starts
everything unseen.

Each tab row reports its **own** activity, not the task's roll-up — tab 2 can
spin while tab 1 rests. The tab strip at the top of the workspace uses a
similar but separate vocabulary (`●` running, `✓` done, `!` error, `?` needs
input, `○` idle).

## Inbox

`ctrl+a` `i` opens it. The Inbox answers two questions — *what needs me?* and
*where was I?* — with one section for each:

- **ATTENTION** — pending items, oldest first. An item appears when a turn
  completes, a session asks for input, hits a rate limit, or errors. One item
  per task-and-tab: a newer event replaces the older one, and starting a new
  turn clears it.
- **RECENT** — the last handful of tabs you visited, most recent first. These
  aren't pending work, just jump targets; a spinner marks the ones still
  running.

`enter` opens the target and clears the item; `d` clears without navigating
(ATTENTION rows only — RECENT rows have nothing to drop). You rarely need
`d`: **visiting a target clears its item anyway** — visiting means handled —
and stale items whose tab or task is gone get cleaned up in the background.

`F7` jumps straight to the oldest pending item across **all** projects,
without opening the Inbox, and cycles on repeated presses. It works even
while you're typing inside an engine session. With nothing pending it just
says so.

## Diff review

The files pane shows what changed; diff review lets you respond. Press `d`
on a file to open its read-only diff, then:

1. `j` / `k` move the line cursor.
2. `v` anchors a range — move to the other end with `j`/`k`; `v` again
   cancels. Skip this for a single-line note.
3. `c` writes a note for the current line or range.
4. `s` sends **all** unsent notes — across all files of the task — to the
   engine as one prompt, and submits it.

The prompt the engine receives is just file, line numbers, and your words —
no code excerpt. The engine reads the worktree itself. Notes are stored per
task and survive restarts; the footer counts `notes · unsent` so you always
know what's pending. Sending doesn't switch tabs — keep reviewing while the
engine works.

Notes anchor to the file path and the line number displayed at the time you
wrote them; they don't re-anchor when the diff changes underneath. These four
keys are fixed and not rebindable.

## Starting sessions: the new-session dialog

`ctrl+e` is the one dialog for starting anything. It lists your detected
engines, a `shell`, and any plugin panes. Two toggles set what happens:

- `tab` flips the **destination**: a new tab in this worktree ⇄ a forked
  child task in a fresh worktree.
- `ctrl+f` flips the **context**: a fresh conversation ⇄ continue this one.

Flip either toggle and the list narrows to engines only — a shell can't
continue a conversation, and a plugin pane isn't a task.

**Continue** with the same engine forks the conversation natively; picking a
different engine performs a hand-off — the new session opens with a pointer
to the old transcript and picks up from there. Engines that keep no readable
transcript can't be continued from, and the dialog says so.

**Fork a child task** opens the quick composer (prompt, engine, branch). The
child branches from your task's **current branch**, so committed work carries
over — uncommitted changes stay behind; commit first if the child needs them.

`ctrl+a` `c` (continue in a new tab) and `ctrl+a` `f` (fork a child task)
open the same dialog with the toggles pre-set.

## Pages: `ctrl+a` `1` / `2` / `3`

Three pages replace the workspace pane while the sidebar stays put. `esc` or
`q` closes a page; selecting a task in the sidebar also returns you to the
workspace. The chords stay live, so you can hop between pages directly.

### Kanban (`ctrl+a` `1`)

The [issue store](CONCEPTS.md#the-issue-store) as a board, one project at a
time (`tab` cycles projects). Three columns:

- **Backlog** — open, doing, or on hold, not linked to a task.
- **In progress** — linked to a task. The link *is* the column: agents move
  cards with `kobe api issue-update --task`, and in-progress cards show the
  linked task's live engine activity.
- **Done** — status `done`.

`enter` opens the detail drawer: edit the title and description, then start a
real session from the card — pick an engine, pick where it runs (the story's
own worktree, or the project checkout), and choose to follow it or stay on
the board. Starting links the issue and flips it to `doing`. `n` creates a
story, `d` deletes one (the issue record only — a linked task and its
worktree are never touched). The board refreshes every few seconds, so cards
moved by agents move on screen too.

### Routines (`ctrl+a` `2`)

Daemon-owned scheduled prompts on five-field cron expressions. Each row shows
the repo, the schedule, and the next run; the detail box below shows the
prompt, the precheck if any, and the last few runs with their outcomes.

`n` creates a routine (name, repo, prompt, schedule), `e` pauses or resumes,
`s` runs one now, `enter` opens the task created by the latest run. There is
no in-page editing — recreate the routine, or use `kobe api routine-update`
(which also sets prechecks; see [kobe api](API.md)). An enabled routine keeps
the daemon alive so schedules fire with no TUI attached.

### GitHub Issues (`ctrl+a` `3`)

A read-only view of the repo's GitHub issues, fetched through the `gh` CLI —
if `gh` works in your terminal, this page works too; otherwise the page tells
you exactly what's missing. `a` filters to issues assigned to you, `tab`
switches repos, `r` refreshes past the cache.

`enter` starts a kobe task from the selected issue: the issue body arrives as
the first prompt (fenced, and explicitly marked as an untrusted report), and
the task keeps a `linkedWorkItem` pointer back to the issue. Nothing is
imported into the local issue store and nothing is written back to GitHub.

## Narrow terminals (phone SSH)

Below **70 columns** the TUI switches to one panel at a time — made for
phone-sized SSH sessions. Nothing changes at 70 columns or wider, and there
is no setting: it follows the terminal width.

- The task list and the workspace alternate: opening a task shows the
  workspace full-width, `ctrl+q` returns to the list. No new chords.
- The first sidebar row is `↩ Recent: <task>` — `enter` drops you back into
  the task you were last working in, and it survives reconnects.
- The files pane is hidden; the pane-cycle keys skip it.
- The tab strip always shows — compressed to the active tab plus a `2/3`
  counter. The usual tab chords still switch.
- The footer keeps one quota chip per engine (`CLAUDE 42%`) and shrinks the
  hints to bare keycaps.
- Dialogs center themselves with tighter padding.

## Attachments: drag and drop, paste

Drop an image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) or a `.pdf` from
your file manager:

- **Onto an engine session** — the path lands in the engine's input, pasted
  but **not submitted**, so you can keep typing around it. The visible
  session catches the drop even when your keyboard focus is elsewhere.
- **Into the quick-task composer or an issue drawer** — the file becomes an
  `images[N]: /path` attachment line sent along with the first prompt.

`ctrl+v` in those dialogs does the same with the clipboard: a copied file
attaches by path, a raw screenshot is saved under `~/.kobe/attachments/`
first. kobe only ever passes paths — the engine reads the file itself.

## Quota in the footer

For engines with a quota probe (Claude Code and Codex today), the footer
shows each usage window the vendor reports — e.g. `CLAUDE 5h 42% → 14:00 ·
7d 12%` — with the percentage colored green below 75%, yellow from 75%, red
from 95%. The same numbers, same thresholds, appear in Settings → General.

The daemon refreshes quota roughly every 15 minutes, so treat the figure as
approximate, not live. When Claude hits its subscription window, kobe
schedules an automatic resume for the affected task and continues it once
the window resets.
