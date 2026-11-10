#!/bin/bash
# Mac用の起動スクリプト（start-*.command）から読み込む共通処理。
# Windowsの start-*.bat と同じ順番で、Ollama・irodori-TTS・わんコメを確認して、
# 起動していなければ起動してから配信ボットを動かす。

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR" || exit 1

# irodori-TTS の場所。別の場所に置いた場合は、環境変数 IRODORI_DIR で変えられる。
export IRODORI_DIR="${IRODORI_DIR:-$HOME/Irodori-TTS}"
# Mac の GPU は mps。CPU で動かしたい時は IRODORI_DEVICE=cpu にする。
export IRODORI_DEVICE="${IRODORI_DEVICE:-mps}"
IRODORI_PYTHON="$IRODORI_DIR/.venv/bin/python"
IRODORI_APP="$IRODORI_DIR/gradio_app_voicedesign.py"
IRODORI_URL="http://127.0.0.1:7861"
OLLAMA_URL="http://127.0.0.1:11434"
LOG_DIR="$APP_DIR/runtime/logs"
mkdir -p "$LOG_DIR"

pause_and_exit() {
  echo
  read -r -n 1 -s -p "何かキーを押すと閉じます..."
  echo
  exit "${1:-0}"
}

check_http() {
  curl -fs -o /dev/null --max-time "${2:-3}" "$1"
}

check_tcp() {
  nc -z -G "${3:-2}" "$1" "$2" >/dev/null 2>&1
}

# wait_http <URL> <待つ秒数> <名前>
wait_http() {
  local waited=0
  while ! check_http "$1" 2; do
    waited=$((waited + 2))
    if [ "$waited" -ge "$2" ]; then
      echo "$3 の起動を待ちきれませんでした。"
      return 1
    fi
    sleep 2
  done
  echo "$3 の準備ができました。"
}

# wait_tcp <ホスト> <ポート> <待つ秒数> <名前>
wait_tcp() {
  local waited=0
  while ! check_tcp "$1" "$2" 2; do
    waited=$((waited + 2))
    if [ "$waited" -ge "$3" ]; then
      echo "$4 の起動を待ちきれませんでした。"
      return 1
    fi
    sleep 2
  done
  echo "$4 の準備ができました。"
}

# config.json（なければ config.example.json）の値を読む。例: config_value ollama.model
config_value() {
  node -e '
    const fs = require("fs");
    const file = fs.existsSync("config.json") ? "config.json" : "config.example.json";
    let value = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const key of process.argv[1].split(".")) value = value?.[key];
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  ' "$1"
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js が見つかりません。Node.js 20 以上を入れてください。"
    return 1
  fi
  if [ ! -f config.json ]; then
    echo "config.json がないので、config.example.json からコピーしました。"
    cp config.example.json config.json
  fi
  if [ ! -d node_modules/tiktok-live-connector ]; then
    echo "Node.js のパッケージを入れます..."
    npm install --no-audit --no-fund || echo "npm install に失敗しました。TikTok のコメントは届きません。"
  fi
}

find_ollama() {
  if command -v ollama >/dev/null 2>&1; then
    command -v ollama
  elif [ -x /Applications/Ollama.app/Contents/Resources/ollama ]; then
    echo /Applications/Ollama.app/Contents/Resources/ollama
  fi
}

start_ollama() {
  local ollama model
  ollama="$(find_ollama)"
  model="$(config_value ollama.model)"
  model="${model:-gemma4:e2b}"

  if check_http "$OLLAMA_URL/api/tags" 2; then
    echo "Ollama はもう動いています。"
  elif [ -z "$ollama" ]; then
    echo "Ollama が見つかりません。https://ollama.com/download から入れてください。"
    return 1
  else
    echo "Ollama を起動します..."
    # Flash Attention と q8_0 のKVキャッシュで、Gemma が使うメモリを減らす（Windowsと同じ設定）。
    OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 \
      nohup "$ollama" serve >"$LOG_DIR/ollama.log" 2>&1 &
    wait_http "$OLLAMA_URL/api/tags" 30 "Ollama" || return 1
  fi

  if curl -fs "$OLLAMA_URL/api/tags" | grep -q "\"name\":\"$model\""; then
    echo "$model は入っています。"
  elif [ -n "$ollama" ]; then
    echo "$model をダウンロードします（数GBあります）..."
    "$ollama" pull "$model" || echo "$model を入れられませんでした。手動で ollama pull $model を実行してください。"
  fi

  echo "$model を読み込めるか確認します..."
  if curl -fs --max-time 180 "$OLLAMA_URL/api/generate" \
    -d "{\"model\":\"$model\",\"prompt\":\"ping\",\"stream\":false,\"options\":{\"num_predict\":1}}" >/dev/null; then
    echo "$model を読み込めました。"
  else
    echo "$model を読み込めませんでした。返事が出ないかもしれません。"
  fi
}

start_irodori() {
  if check_http "$IRODORI_URL/config" 3; then
    echo "irodori-TTS はもう動いています。"
  elif [ -x "$IRODORI_PYTHON" ] && [ -f "$IRODORI_APP" ]; then
    echo "irodori-TTS を起動します（ログ: runtime/logs/irodori.log）..."
    # tools/irodori_lowvram.py は、声を1回作るたびにGPUのメモリを返して、Gemma の分を空けておく。
    nohup "$IRODORI_PYTHON" "$APP_DIR/tools/irodori_lowvram.py" "$IRODORI_DIR" --server-port 7861 \
      >"$LOG_DIR/irodori.log" 2>&1 &
    # Mac はモデルの読み込みに時間がかかるので、Windowsより長めに待つ。
    wait_http "$IRODORI_URL/config" 90 "irodori-TTS" \
      || echo "irodori-TTS はまだ起動中です。声は準備ができてから出ます。"
  else
    echo "irodori-TTS が $IRODORI_DIR に見つかりません。"
    echo "README の「Macで動かす」を見て用意してください。"
    return 1
  fi

  local config
  config="$(curl -fs --max-time 3 "$IRODORI_URL/config")"
  if echo "$config" | grep -q '"api_name":"_run_generation"' && echo "$config" | grep -q "\"$IRODORI_DEVICE\""; then
    echo "irodori-TTS の準備ができました（$IRODORI_DEVICE）。"
  else
    echo "irodori-TTS の API がまだ準備できていません。声は少し後から出ます。"
  fi
}

start_onecomme() {
  if check_tcp 127.0.0.1 11180 2; then
    echo "わんコメはもう動いています。"
  elif [ -d /Applications/OneComme.app ]; then
    echo "わんコメを起動します..."
    open -a /Applications/OneComme.app
    wait_tcp 127.0.0.1 11180 10 "わんコメ" || echo "わんコメはまだ起動中です。ボットがつなぎ直し続けます。"
  else
    echo "わんコメが見つかりません。コメントが届かない時は、わんコメを手動で起動してください。"
  fi
}

# 8790〜8899 の中から空いているポートを探して PORT に入れる。
find_free_port() {
  local port=8790
  while check_tcp 127.0.0.1 "$port" 1; do
    echo "ポート $port は使われているので、次を試します..."
    port=$((port + 1))
    if [ "$port" -gt 8899 ]; then
      echo "8790〜8899 に空いているポートがありません。"
      return 1
    fi
  done
  export PORT="$port"
}

run_bot() {
  find_free_port || return 1
  echo "OBS URL: http://127.0.0.1:$PORT?obs=1"
  echo "OBS vertical URL: http://127.0.0.1:$PORT/vertical"
  if [ "$(config_value audio.playInBrowser)" != "true" ]; then
    echo "（声をOBSに乗せるには、config.json の audio.playInBrowser を true にしてください）"
  fi
  node src/app.js "$@"
  echo
  echo "配信ボットが止まりました。"
}
