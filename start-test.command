#!/bin/bash
# Mac用：配信につながずに、動作確認だけをする。
source "$(dirname "$0")/tools/mac/common.sh"

check_node || pause_and_exit 1
echo "ローカルテストを始めます..."
node src/app.js --local-test
pause_and_exit
