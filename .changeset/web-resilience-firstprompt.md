---
"@sma1lboy/kobe": patch
---

Web resilience + a first-prompt flow. A root error boundary now catches render crashes and shows a themed recovery card (with Reload / Try to recover) instead of a blank white screen — and notes that tasks/engines are untouched since it's a UI-only crash. A dismissable banner appears when the daemon behind the bridge goes offline (SSE still up), explaining that task data is frozen and recovers automatically. The New Task dialog gains an optional "First prompt" field: creating a task with one opens an engine tab and seeds the prompt into its composer, ready to send the moment the engine is up — no PTY-readiness guessing.
