#!/bin/bash

PORT=4477

# 查找占用端口的进程并关闭
PID=$(lsof -ti :$PORT)
if [ -n "$PID" ]; then
  echo "Killing process $PID on port $PORT..."
  kill -9 $PID
  sleep 1
fi

# 启动服务
echo "Starting server..."
npm start
