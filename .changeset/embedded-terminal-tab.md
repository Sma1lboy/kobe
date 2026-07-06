---
"@sma1lboy/kobe": patch
---

Terminal-in-the-middle lands (issue #16): the dormant embedded-terminal pane is revived — overflow clipping via opentui 0.4, the StyledText snapshot pushed through the renderable's content setter (the solid binding's content prop stringifies at runtime), user-visible strings moved to a new terminal.* i18n namespace — and the KOBE_TUI workspace's center column now runs the task's real interactive engine CLI in an in-process Bun PTY. A dev:mock-terminal entry proves the PTY→xterm→render seam live.
