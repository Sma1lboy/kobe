---
"@sma1lboy/kobe": patch
---

Live tab titles no longer drop when a terminal's window-title escape splits across a read boundary.

The pty host's OSC 0/2 title scan carried an unterminated sequence into the next chunk by anchoring on the last raw ESC byte, so when a title's ST terminator (`ESC \`) or its introducer split across a PTY read boundary, the carry kept only the trailing lone ESC and discarded the whole `ESC ]0;title` prefix — the title (and the tab name it drives) was silently lost until the next full title arrived. The carry now anchors on the OSC introducer instead, so a title spanning two chunks is reassembled and reported by `pty.list` / `kobe api pty-list` and the tab strip.
