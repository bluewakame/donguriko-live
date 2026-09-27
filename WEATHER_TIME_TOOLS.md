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
大阪の天気は？
明日の札幌の天気
あさって福岡は雨降る？
```

Weather uses Open-Meteo and only fetches data when a weather-like comment is
received. Results are cached per location for 10 minutes by default.

If the comment names one of the 47 prefectures or a major city listed in
`WEATHER_PLACES` (`src/app.js`), that place is used (prefectures use the
prefectural capital). Otherwise the configured location below is used. If a
comment asks about a place that is not in the list (e.g. `パリの天気は？`),
Donguriko replies that the place is not on the map yet. To support more places, add entries to
`WEATHER_PLACES`.

`明日` / `あさって` / `しあさって` in the comment switch the reply to the daily
forecast (weather, high/low temperature, chance of rain).

To check the replies without starting the stream:

```bash
node src/app.js --weather-test
```

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

To change the default weather location, update `locationName`, `latitude`, and
`longitude` in `config.json`.
