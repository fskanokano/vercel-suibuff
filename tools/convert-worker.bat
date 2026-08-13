@echo off
rem ============================================================
rem convert-worker.bat — 一键把 Cloudflare Worker 转换为 Vercel 兼容格式
rem 用法:
rem   convert-worker.bat <worker.js> [输出文件] [--verify]
rem   或直接把 worker.js 文件拖拽到本脚本图标上
rem
rem 需要: node >= 18 (https://nodejs.org)
rem 输出: 默认生成 <worker>.vercel.js（原文件不被修改）
rem 转换: 只做两处最小改动，业务逻辑零改动（详见 worker2vercel.mjs 头部注释）
rem ============================================================
setlocal
set "DIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 错误: 未找到 node。请先安装 Node.js ^>= 18: https://nodejs.org
  exit /b 1
)

for /f "delims=" %%v in ('node -e "console.log(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 18 (
  echo 错误: 需要 Node.js ^>= 18，当前为 %NODE_MAJOR%。请升级: https://nodejs.org
  exit /b 1
)

echo ── worker2vercel ─────────────────────────────
node "%DIR%worker2vercel.mjs" %*
exit /b %errorlevel%
