---
"@sma1lboy/rove": patch
---

Refresh the sidebar frame goldens so the render track matches the row cards.
The `ctrl+<digit>` jump hint stopped being printed on rows, but the golden
frames still carried the digit column, leaving CI red on `main`.
