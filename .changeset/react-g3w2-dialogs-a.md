---
"@sma1lboy/kobe": patch
---

React ports of the small shared dialogs + notifications (issue #15, G3 wave 2): NotificationsProvider (wired into the React pane host's provider nest), HelpDialog, ToastOverlay, and VersionSkewBanner under `src/tui-react/`, with `kobe help-page` selecting the React host behind `KOBE_REACT=1`. The pure notification state transforms and help-dialog category grouping moved to framework-free `src/tui/lib/{notify-state,help-groups}.ts` shared by both runtimes, and a `dev:mock-react-dialogs` workbench proves banner/toast/help render live.
