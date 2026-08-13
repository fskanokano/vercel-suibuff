// 模拟 Vercel 运行时（@vercel/node >= 5 createWebHandler 逻辑）验证改造后的 worker.js
// 关键点：Vercel 调用 fetch 只传 request（不传 env），验证 envShim 是否生效
// 用法：先设环境变量再加载模块（模拟 Vercel 冷启动注入 env 后再加载函数）
import { createServer } from "node:http";
import { Readable } from "node:stream";

const HOST = "127.0.0.1";
const PORT = 18777;

async function loadWorker() {
  // 每次调用都带新 query，强制重新加载模块（模拟独立冷启动）
  return (await import("./api/worker.js?cold=" + Date.now())).default;
}

async function run() {
  console.log("=== 1. 检查导出形态（Vercel isWebHandler 检测） ===");
  const worker = await loadWorker();
  const listener = worker?.default ?? worker;
  const isWebHandler = typeof listener === "object" && typeof listener.fetch === "function";
  console.log("export default 对象带 fetch 方法:", isWebHandler ? "✅ 通过（Vercel 原生支持）" : "❌ 失败");
  if (!isWebHandler) { console.log("实际导出:", typeof listener, listener && Object.keys(listener)); process.exit(1); }

  // 按 @vercel/node bundling-handler.js 的 createWebHandler 逻辑搭桥
  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const url = new URL(req.url || "/", `${proto}://${host}`);
    const init = { method, headers: req.headers, duplex: "half" };
    if (method !== "GET" && method !== "HEAD") init.body = Readable.toWeb(req);
    const request = new Request(url, init);
    let response;
    try {
      response = await listener.fetch(request); // ← Vercel 只传 request，不传 env
    } catch (e) {
      res.statusCode = 500; res.end("Internal Server Error: " + e.message); return;
    }
    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);
    if (response.body) { for await (const chunk of response.body) res.write(chunk); }
    res.end();
  });

  await new Promise(r => server.listen(PORT, HOST, r));
  const base = `http://${HOST}:${PORT}`;

  async function test(name, path, opts = {}) {
    try {
      const r = await fetch(base + path, opts);
      const body = await r.text();
      let parsed = null; try { parsed = JSON.parse(body); } catch {}
      console.log(`\n--- ${name} ---`);
      console.log(`  状态: ${r.status}${r.status !== 200 ? " (预期非200)" : ""}`);
      if (parsed && parsed.error) console.log(`  error.type: ${parsed.error.type}`);
      if (parsed && parsed.status) console.log(`  health: ${parsed.status}, version: ${parsed.version}`);
      if (parsed && parsed.data) console.log(`  模型数: ${parsed.data.length}, 首个: ${parsed.data[0].id}`);
      const ok = opts.expect === undefined || r.status === opts.expect;
      console.log(ok ? "  ✅ 通过" : "  ❌ 失败");
      return r.status;
    } catch (e) {
      console.log(`  ❌ 异常: ${e.message}`); return -1;
    }
  }

  await test("GET /healthz（免鉴权）", "/healthz", { expect: 200 });
  await test("POST /v1/chat/completions 无 API key（应 401）", "/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }),
    expect: 401,
  });
  await test("OPTIONS 预检（应 204）", "/v1/chat/completions", { method: "OPTIONS", expect: 204 });
  await test("GET /v1/models 带默认 key（freebuff-default-key）", "/v1/models", {
    headers: { Authorization: "Bearer freebuff-default-key" }, expect: 200,
  });
  await test("GET /v1/models 错误 key（应 401）", "/v1/models", {
    headers: { Authorization: "Bearer wrong-key" }, expect: 401,
  });
  await test("POST /v1/messages 无 key（应 401）", "/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }),
    expect: 401,
  });

  console.log("\n=== 2. envShim 与 process.env 联通性验证 ===");
  // 先注入环境变量（模拟 Vercel 冷启动时环境变量已就绪），再重新加载模块
  process.env.API_KEY = "env-test-key-123";
  const { default: workerCold } = await import("./api/worker.js?cold2=" + Date.now());
  const coldListener = workerCold?.default ?? workerCold;
  const r2 = await coldListener.fetch(new Request(`http://${HOST}/v1/models`, {
    headers: { Authorization: "Bearer env-test-key-123" },
  }));
  console.log("process.env.API_KEY=env-test-key-123 后用它访问 /v1/models:", r2.status === 200 ? "✅ 通过（env 适配生效）" : `❌ 失败: ${r2.status}`);
  const r2b = await coldListener.fetch(new Request(`http://${HOST}/v1/models`, {
    headers: { Authorization: "Bearer freebuff-default-key" },
  }));
  console.log("旧默认 key 应失效（401）:", r2b.status === 401 ? "✅ 通过" : `❌ 失败: ${r2b.status}`);
  delete process.env.API_KEY;

  server.close();
  console.log("\n=== 全部测试完成 ===");
}

run().catch(e => { console.error("测试失败:", e); process.exit(1); });
