#!/bin/bash
# sku-manager 启动入口(macOS / Linux)
# macOS 上可直接双击运行;首次使用需先执行一次:chmod +x start.command
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 LTS 版本:https://nodejs.org"
  echo "按回车键关闭。"
  read -r
  exit 1
fi

node scripts/launch.js
code=$?

# 出错时留住窗口,便于看报错(双击运行时窗口会立刻消失)
if [ $code -ne 0 ]; then
  echo ""
  echo "启动失败(退出码 $code)。按回车键关闭。"
  read -r
fi
