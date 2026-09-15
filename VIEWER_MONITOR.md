# Viewer Monitor

Donguriko can say a short message when the YouTube concurrent viewer count
increases.

## What It Says

Default message:

```text
見に来てくれた人が増えたみたい。よかったら気軽にコメントしてね、どんぐりこ待ってるよ。
```

## Enable

In `config.json`, set:

```json
"viewerMonitor": {
  "enabled": true,
  "pollIntervalMs": 60000,
  "increaseThreshold": 1,
  "cooldownMs": 300000,
  "message": "見に来てくれた人が増えたみたい。よかったら気軽にコメントしてね、どんぐりこ待ってるよ。"
}
```

## Requirements

This uses the YouTube API, so YouTube OAuth settings must be configured.

If you know the broadcast/video ID, set:

```json
"youtube": {
  "enabled": false,
  "clientId": "YOUR_YOUTUBE_OAUTH_CLIENT_ID",
  "clientSecret": "YOUR_YOUTUBE_OAUTH_CLIENT_SECRET",
  "redirectPort": 8788,
  "pollIntervalMs": 6000,
  "broadcastId": "YOUR_LIVE_VIDEO_ID"
}
```

Then run:

```text
npm run auth
```

After that, start the live bot normally.

## Notes

- It checks viewer count every 60 seconds by default.
- It waits 5 minutes between announcements by default.
- It only speaks after an increase is detected.
- It does not add this announcement to `memory-inbox.md`.
