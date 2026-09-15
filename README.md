# YouTube Gemma Local TTS Live Bot

わんコメからコメントを受け取り、ローカルのOllama/Gemmaで返答を作り、AivisSpeechで読み上げ、OBSへどんぐりこのLive2Dモデルを表示する配信ボットです。読み上げ音声の音量に合わせて口が動きます。YouTube Data APIは使わない構成です。

## 必要なもの

- Node.js 20以上
- OBS Studio
- Ollama
- Gemma系モデル
- AivisSpeech
- わんコメ

## 初回設定

1. `config.example.json` を `config.json` にコピーします。
2. OllamaでGemmaモデルを用意します。

```powershell
ollama pull gemma4:e2b
```

3. AivisSpeech Engineを起動します。
4. わんコメを起動し、WebSocket/API機能を有効にします。
5. Live2Dモデルは `public/live2d/Donguriko/` に配置済みです（差し替える場合は下の「Live2Dモデル」を参照）。

## 起動

Windowsでは次のファイルをダブルクリックすると、Ollama/AivisSpeech/わんコメの確認と配信ボット起動をまとめて行います。

```text
start-live.bat
```

テストだけ実行する場合:

```text
start-test.bat
```

手動で起動する場合:

```powershell
node src/app.js
```

## OBS URL

横型:

```text
http://127.0.0.1:8787?obs=1
```

縦型:

```text
http://127.0.0.1:8787/vertical
```

ブラウザで通常URLを開くと、左上に手動読み上げ用の入力欄が出ます。

```text
http://127.0.0.1:8787
```

## Live2Dモデル

立ち絵はLive2D（Cubism 4/5）モデルをブラウザ上で描画しています。スプライト立ち絵の描画コードも残してあり、モデルの読み込みに失敗したときは自動的に以前の立ち絵に戻ります。

| 場所 | 中身 |
| --- | --- |
| `public/live2d/Donguriko/` | ランタイムモデル一式（`Donguriko.model3.json` / `.moc3` / `.cdi3.json` / `Donguriko.2048/texture_00.png`） |
| `public/vendor/` | Live2D Cubism Core・PixiJS 6.5.10・pixi-live2d-display 0.4.0（同梱済みなのでオフラインでも動作） |
| `public/live2d.js` | モデルの読み込みとパラメータ制御 |

モデルの元データ（`.cmo3` / `.psd`）は `Documents\Codex\2026-09-06\Live2DDonguriko\outputs\Donguriko_Live2D` にあります。Cubismで編集して書き出したら、書き出しフォルダの中身を `public/live2d/Donguriko/` へ上書きしてください。

動かしているパラメータは次の6つです。まばたきは `model3.json` の EyeBlink グループを使ってライブラリ側が自動で行います。

| 動き | パラメータ | 駆動元 |
| --- | --- | --- |
| 口の開閉 | `ParamMouthOpenY` | 読み上げ音声の音量（リップシンク） |
| 首の左右・上下 | `ParamAngleX` / `ParamAngleY` | 視線ターゲット（自動＋キーボード操作） |
| 首の傾き | `ParamAngleZ` | ゆっくりした揺れ（しゃべっている間は少し大きく） |
| まばたき | `ParamEyeLOpen` / `ParamEyeROpen` | 自動 |

現在のモデルには物理演算ファイル（`.physics3.json`）とモーション（`.motion3.json`）が無いため、髪やしっぽの揺れ・表情差分はありません。Cubismで追加すればそのまま反映されます。

## 音声の再生場所

`config.json` の `audio.playInBrowser` が `true` のときは、生成した音声を**ブラウザ側で再生**します。口パクは再生中の音量から作っているので、この設定がリップシンクの前提です。

- OBSの「ブラウザソース」のプロパティで **音声をOBSで制御する** を有効にしてください（OBSのミキサーに `Donguriko Live` の音量が出ます）。
- 表示を1つも開いていないときは、従来どおりPC側（PowerShell）で再生します。
- 普通のブラウザで開いた場合、最初の1回だけ画面をクリックしないと音が出ないことがあります（その旨がステータス行に出ます）。
- サーバー側再生に戻したい場合は `audio.playInBrowser` を `false` にしてください。

## 表示の調整（URLパラメータ）

| パラメータ | 既定値 | 内容 |
| --- | --- | --- |
| `modelScale` | `1` | モデルの拡大率 |
| `modelX` | `0.5` | 横位置（0＝左端、1＝右端） |
| `modelY` | `1` | 足元の縦位置（0＝上端、1＝下端） |
| `volume` | `1` | ブラウザ再生の音量（0〜1） |
| `mouthGain` | `5.5` | 口の開き具合。大きいほどよく開く |

例:

```text
http://127.0.0.1:8790?obs=1&modelScale=1.15&modelX=0.42&mouthGain=6.5
```

## 短期記憶

直近の会話は `runtime/memory.json` に保存されます。保存する件数は `config.json` の `memory.maxTurns` で調整できます。不要な場合は `memory.enabled` を `false` にしてください。

## ひとりごと（コメントが止まった時の自動発話）

一定時間コメントが来ないと、どんぐりこが自分から話しかけます。設定は `config.json` の `idleTalk` です。

| キー | 既定値 | 内容 |
| --- | --- | --- |
| `enabled` | `true` | 機能のオンオフ |
| `idleMs` | `180000` | 最後のコメントからこの時間コメントが無いとひとりごとを始める（3分） |
| `checkIntervalMs` | `15000` | 無コメント時間を確認する間隔 |
| `minIntervalMs` | `120000` | ひとりごとを話し終えてから次を話すまでの最短間隔（2分） |
| `maxConsecutive` | `3` | コメントが1件も来ないまま連続で話す最大回数（`0`で無制限） |
| `useLlm` | `true` | `true`ならお題からAIで文章を作る。`false`なら`messages`からランダムに選ぶ |
| `topics` | 7件 | ひとりごとのお題。直近で使ったお題は避けて選ばれます |
| `messages` | 3件 | AIの生成に失敗した時に読み上げる固定文 |

- 読み上げ中やコメント処理中は割り込みません。キューが空いた時だけ話します。
- コメント（手動読み上げを含む）が来ると無コメント時間と連続回数はリセットされます。
- ひとりごとは短期記憶や `memory-inbox.md` には保存しません。
- 画面のコメント欄には `ひとりごと / お題: ○○` と表示されます。

## 運用メモ

- コメント取得はわんコメ側に任せるため、このアプリではYouTube Data APIクォータを消費しません。
- 画面右下には `AivisSpeech: コハク` が常に表示されます。
- Live2D Cubism SDK for Web を同梱しているので、公開・配信で使う前にLive2D社のライセンス条件を確認してください。
- `config.json` の `bot.ngWords` にNGワードを追加できます。
- 使っているAIモデル名を聞かれた場合は、具体名を出さずにぼかすよう設定しています。
