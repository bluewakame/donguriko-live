#!/bin/bash
# Mac用：Finderでダブルクリックすると、Ollama・irodori-TTS・わんコメを確認して配信ボットを起動する。
source "$(dirname "$0")/tools/mac/common.sh"

echo "[1/5] Node.js を確認しています..."
check_node || pause_and_exit 1

echo "[2/5] Ollama を確認しています..."
start_ollama

echo "[3/5] irodori-TTS を確認しています..."
start_irodori

echo "[4/5] わんコメを確認しています..."
start_onecomme

echo "[5/5] 配信ボットを起動します..."
run_bot
pause_and_exit
