---
"@sma1lboy/kobe": patch
---

G3 groundwork (issue #15): React pane hosts get a real bootPaneHost — shared boot steps (crash handlers, keybindings.yaml overlay, user themes), persisted-prefs seeding before first paint, a themed crash boundary, and the shared exit-signal backstop. Live daemon ui-prefs/keybindings pushes now ride framework-free external-store twins in the client layer (solid-js signals are inert outside reactive-solid runtimes), consumed by React via subscribe/get; dev:mock-react boots through the real host path.
