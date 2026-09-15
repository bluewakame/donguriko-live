# Weather and Time Tools

Donguriko can answer simple time and weather questions before sending the
comment to the local LLM.

## Time

Examples:

```text
今何時？
現在時刻教えて
```

Settings:

```json
"time": {
  "enabled": true,
  "timeZone": "Asia/Tokyo",
  "label": "日本"
}
```

## Weather

Examples:

```text
天気教えて
今の気温は？
雨降ってる？
```

Weather uses Open-Meteo and only fetches data when a weather-like comment is
received. Results are cached for 10 minutes by default.

Settings:

```json
"weather": {
  "enabled": true,
  "locationName": "東京",
  "latitude": 35.6812,
  "longitude": 139.7671,
  "timeZone": "Asia/Tokyo",
  "cacheMs": 600000
}
```

To change the weather location, update `locationName`, `latitude`, and
`longitude` in `config.json`.
