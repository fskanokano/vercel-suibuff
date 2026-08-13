# vercel-suibuff

[freebuff2api-wokers](https://github.com/pingmike2/freebuff2api-wokers) 的 `worker.js` 改造版 —— 在 **Vercel** 上单文件直接部署，无需 Cloudflare。

## 部署（3 步）

1. **导入仓库**：在 [vercel.com/new](https://vercel.com/new) → Import Git Repository 选择本仓库（Framework Preset 选 **Other**），Deploy。
2. **配置环境变量**：项目 Settings → Environment Variables，按下方表格添加。
3. **使用**：Base URL 填 `https://你的项目名.vercel.app/v1`，API Key 填 `API_KEY` 的值（未配置则用 `freebuff-default-key`）。

> 部署后访问 `https://你的项目名.vercel.app/healthz` 验证（无需 API key）：
> ```json
> {"status":"ok","version":"1.8.9","time":"..."}
> ```

## 环境变量（与 Cloudflare Worker 完全同名，用法一致）

| 变量 | 必需 | 说明 |
|---|---|---|
| `FREEBUFF_TOKEN` | ✅ | freebuff token。多账号用**换行**或**逗号**分隔；每项可带 `:uid` 后缀（如 `t1\nt2:u2`） |
| `API_KEY` | 可选 | 访问 API key，缺省 `freebuff-default-key` |
| `FREEBUFF_API_KEY` | 可选 | `API_KEY` 的别名，两者取其一 |
| `FREEBUFF_DEBUG` | 可选 | 设为 `"true"` 开启调试日志 |

> ⚠️ 配置了 `API_KEY`/`FREEBUFF_API_KEY` 后，访问时必须使用你配置的值，默认 `freebuff-default-key` 会失效（401）。

## 适配原理（最小改动）

- 原 `worker.js` 是 Cloudflare Worker 格式 `export default { fetch(request, env) }`。
- **Vercel 的 Node 运行时（@vercel/node ≥ 5）原生识别该形态**：导出的对象带 `fetch` 方法时，自动把 Node `IncomingMessage` 桥接成标准 Web `Request` 调用 `fetch(request)`，并把返回的 Web `Response` 流式写回 —— SSE / 流式响应无损。
- 唯一差异：CF 由平台注入 `env`，Vercel 调用 `fetch` 只传 `request`。因此文件末尾新增了 **env 适配层**，用 `process.env` 构造等价的 `envShim`（变量名不变，见上方表格）。
- 路由：`vercel.json` 中 `rewrites: [{"source": "/(.*)", "destination": "/api/worker"}]` 全量转发。**实测（2026-08-13）Vercel rewrite 到函数时保留原始 URL**（`/healthz`、`/v1/*`、query 参数均原样到达），worker 内部路由正常工作。

> 🐛 踩坑记录：最初用 `api/[...all].js` catch-all 文件系统路由，实测只匹配 `/api/单段`（如 `/api/anything`），根级路径 `/healthz`、`/v1/*` 全部平台 404（`x-vercel-error: NOT_FOUND`）。务必使用 rewrites 方案。

## 一键转换工具（tools/）

把任意 Cloudflare Worker（`export default { fetch(request, env) }` 形态）转换为 Vercel 兼容格式，**业务逻辑零改动**，只做两处最小改动：

1. `export default {` → `const __cfWorkerExport = {`（原对象原封不动）
2. 文件末尾追加 Vercel 适配层：自动收集 `env.<NAME>` 引用生成 `envShim`（映射 `process.env.<NAME>`，变量名不变），并导出 `{ fetch(request) }` 形态供 Vercel 运行时识别

```bash
# Linux / macOS（脚本会自动检查 node）
./tools/convert-worker.sh my-worker.js              # 生成 my-worker.vercel.js
./tools/convert-worker.sh my-worker.js --verify     # 转换并验证导出形态

# Windows
convert-worker.bat my-worker.js
```

转换器也支持 `fetch: async function (req, env)`、`fetch: (req, env) =>` 等变体形态、模板字符串/注释中的花括号（括号配平器安全处理）、旧格式报错提示、防重复转换。

> 转换后部署到 Vercel：把 `my-worker.vercel.js` 放入 `api/` 目录（或按仓库顶层 `vercel.json` 的 rewrites 方式路由），在项目 Settings → Environment Variables 配置同名环境变量。

## 文件结构

```
├── api/
│   └── worker.js          ← 核心实现（改造后的单文件）
├── tools/
│   ├── worker2vercel.mjs  ← 转换器核心（node 实现，跨平台）
│   ├── convert-worker.sh  ← Linux/macOS 一键脚本
│   ├── convert-worker.bat ← Windows 一键脚本
│   └── test-converted.mjs ← 转换结果功能验证脚本
├── vercel.json            ← rewrites 全量路由（唯一路由配置）
├── package.json           ← type: module（worker.js 为 ESM）
└── test-vercel.mjs        ← 本地模拟 Vercel 运行时验证脚本（node test-vercel.mjs）
```

## 支持的 API

与原版 Cloudflare Worker 一致：

- `GET /v1/models` — 模型列表（含动态官方清单，6h 缓存）
- `POST /v1/chat/completions` — OpenAI 格式（支持 SSE 流式）
- `POST /v1/responses` — OpenAI Responses 格式
- `POST /v1/messages` — Anthropic 格式（含流式）
- `POST /v1/messages/count_tokens` — token 计数
- `GET /healthz` — 健康检查（免鉴权）

> ⚠️ Vercel Serverless 注意：函数最长执行时间 60s（Hobby 计划），长对话流式输出请留意超时；内存 1024MB 内足够。
