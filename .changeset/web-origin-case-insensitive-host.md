---
"@sma1lboy/kobe": patch
---

Fix the daemon dashboard rejecting every browser request with a 403 when it is bound to a host whose name carries an uppercase letter — routine for mDNS names like `MyMac.local`. Browsers (and the URL parser) lowercase the Origin host they send, but the allowed bind host was compared with its original case, so `mymac.local` never matched `MyMac.local` and the whole LAN dashboard was locked out; hostnames are case-insensitive (RFC 4343) and the Origin check now compares them that way.
