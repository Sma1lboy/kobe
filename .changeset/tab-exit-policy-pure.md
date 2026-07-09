---
"@sma1lboy/kobe": patch
---

Extract the remaining terminal tab/split decision logic out of the React components into the framework-free `terminal-tabs-core` module — the engine-tab resume-vs-pin argv choice (`engineTabArgv`), the tab exit policy (`tabExitAction`: close / one-shot resume / degrade to shell), the split collapse-to-unsplit rule (`collapseSplit`), and the is-split keybinding gate (`isTabSplit`) — with unit coverage for each. Behavior-invariant; `TerminalTabs`/`TerminalSplit` now only dispatch.
