#!/bin/sh
# ============================================================
# convert-worker.sh — 一键把 Cloudflare Worker 转换为 Vercel 兼容格式
# 用法:
#   ./convert-worker.sh <worker.js> [输出文件] [--verify]
#   或直接把 worker.js 拖到本脚本上（macOS/Linux 终端）
#
# 需要: node >= 18（https://nodejs.org）
# 输出: 默认生成 <worker>.vercel.js（原文件不被修改）
# 转换: 只做两处最小改动，业务逻辑零改动（详见 worker2vercel.mjs 头部注释）
# ============================================================
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 node。请先安装 Node.js >= 18: https://nodejs.org"
  exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误: 需要 Node.js >= 18，当前为 $(node -v)。请升级: https://nodejs.org"
  exit 1
fi

echo "── worker2vercel ─────────────────────────────"
node "$DIR/worker2vercel.mjs" "$@"
