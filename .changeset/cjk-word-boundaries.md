---
"@sma1lboy/kobe": patch
---

TUI 输入框中文分词:alt+←/→ 跳词、alt+backspace 删词现在按中文词语(Intl.Segmenter)移动,`]`、`=`、全角标点都是词边界;之前 native 词边界对中文是固定步长乱跳。覆盖所有 `<input>`/`<textarea>`(quick-task、new-task、rename、settings)。
