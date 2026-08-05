---
"@sma1lboy/kobe": patch
---

Fix the automation schedule preview spelling four of the seven weekdays wrong — a `TUE`/`WED`/`THU`/`SAT` cron rendered "Tuedays", "Weddays", "Thudays", "Satdays"; the preview now names every weekday correctly and stays silent on an hourly list/range minute (`15,45 * * * *`) instead of asserting a fire time (`:15,45`) the schedule never has.
