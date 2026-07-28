# examples.notify

Desktop notifications (macOS `osascript`, Linux `notify-send`) whenever a kobe
agent finishes a turn, errors, hits a rate limit, or waits on a permission
prompt. Optionally pushes the same message to an [ntfy](https://ntfy.sh) topic
so it reaches your phone.

```bash
kobe plugin install Sma1lboy/kobe/plugins/notify
kobe plugin action invoke examples.notify.test        # smoke-test it
```

Phone push (optional):

```bash
echo 'NTFY_URL=https://ntfy.sh/<your-topic>' > "$(kobe plugin config-dir examples.notify)/.env"
```
