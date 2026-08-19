---
"@sma1lboy/rove": patch
---

The sidebar's right-click menu dismisses on the next press anywhere

Opening a row's context menu used to leave it up until you re-clicked a row or
pressed escape — a press in the terminal, the file tree, or the sidebar's empty
space left it hanging over a row it no longer described. A press anywhere now
dismisses it, which is what every other popup on the machine does.

The signal is one listener on the renderer root: opentui bubbles a mouse event
up the renderable chain, and nothing in the TUI stops the DOWN phase (the
panes' guards all sit on `onMouseUp`), so root-level down means "the user just
pressed somewhere else" without every pane having to report it. A backdrop box
could not have done this — an overlay is an absolute child of the pane that
owns it, and the menu is clipped to the sidebar rail. The menu itself stops its
own press, so clicking an entry still fires on the mouse-up.
