---
"@sma1lboy/kobe": patch
---

Quick-fork composer accepts multimodal attachments. Paste an image or PDF file path (Finder copy / drag-drop — multi-file paste works) and it becomes an attachment chip instead of prompt text; press ctrl+v to pull a raw clipboard image (screenshot), which is saved under `~/.kobe/attachments/` and attached by path. Chips render as `images[0]` / `pdf[1]`, click a chip or press ctrl+x to remove, and on create the references are appended to the delivered prompt as `images[0]: /path` lines so the engine reads the files itself.
