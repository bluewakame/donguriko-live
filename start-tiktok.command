#!/bin/bash
# Mac用：TikTok LIVEのコメントだけで配信ボットを起動する（わんコメは使わない）。
source "$(dirname "$0")/tools/mac/common.sh"

echo "[1/4] Node.js を確認しています..."
check_node || pause_and_exit 1
if [ -z "$(config_value tiktok.uniqueId)" ]; then
  echo "config.json の tiktok.uniqueId が空です。TikTokのユーザー名（@の後ろ）を入れてください。"
  pause_and_exit 1
fi

echo "[2/4] Ollama を確認しています..."
start_ollama

echo "[3/4] irodori-TTS を確認しています..."
start_irodori

echo "[4/4] 配信ボットを起動します（TikTokのみ）..."
run_bot --tiktok-only
pause_and_exit
