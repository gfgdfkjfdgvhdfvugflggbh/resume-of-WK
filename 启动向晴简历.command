#!/bin/zsh

cd "$(dirname "$0")" || exit 1

echo "正在启动向晴简历…"
echo "测试地址：http://127.0.0.1:4173"
echo "关闭本窗口即可停止服务。"

python3 server.py &
SERVER_PID=$!

trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM
sleep 1
open "http://127.0.0.1:4173"
wait $SERVER_PID
