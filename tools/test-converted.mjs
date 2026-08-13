// 验证 worker2vercel 转换结果的完整功能（模拟 Vercel createWebHandler 桥接）
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const target = process.argv[2] || "./api/worker.js";
const HOST = "127.0.0.1";
const PORT = 18778;

async function run() {
  process.env.API_KEY = "func-test-key";
  const mod = await import(pathToFileURL(target).href + "?t=" + Date.now());
  const listener = mod.default?.default ?? mod.default ?? mod;
  if (typeof listener !== "object" || typeof listener.fetch !== "function") {
    console.error("❌ 导出形态异常:", typeof listener); process.exit(1);
  }
  console.log(`✅ 加载成功: ${target}，导出 { fetch(request) } 形态正确`);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
    const init = { method: req.method || "GET", headers: req.headers, duplex: "half" };
    if ((req.method || "GET") !== "GET" && (req.method || "GET") !== "HEAD") init.body = Readable.toWeb(req);
    let response;
    try { response = await listener.fetch(new Request(url, init)); }
    catch (e) { res.statusCode = 500; res.end("ERR: " + e.message); return; }
    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);
    if (response.body) { for await (const c of response.body) res.write(c); }
    res.end();
  });
  await new Promise(r => server.listen(PORT, HOST, r));
  const base = `http://${HOST}:${PORT}`;

  async function t(name, path, opts = {}, expect) {
    const r = await fetch(base + path, opts);
    const body = await r.text();
    let parsed = null; try { parsed = JSON.parse(body); } catch {}
    const ok = expect === undefined ? true : r.status === expect;
    console.log(`${ok ? "✅" : "❌"} ${name}: ${r.status}${parsed?.error ? " " + parsed.error.type : ""}${ok ? "" : ` (期望 ${expect}, body: ${body.slice(0, 80)})`}`);
    if (!ok) process.exitCode = 1;
  }

  await t("GET /healthz", "/healthz", {}, 200);
  await t("OPTIONS 预检", "/v1/chat/completions", { method: "OPTIONS" }, 204);
  await t("POST /v1/chat/completions 无 key", "/v1/chat/completions",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "m", messages: [] }) }, 401);
  await t("GET /v1/models 自定义 API_KEY", "/v1/models", { headers: { Authorization: "Bearer func-test-key" } }, 200);
  await t("GET /v1/models 默认 key 失效", "/v1/models", { headers: { Authorization: "Bearer freebuff-default-key" } }, 401);
  await t("GET /healthz?q=1 query 保留", "/healthz?q=1", {}, 200);

  server.close();
  console.log(process.exitCode ? "\n❌ 存在失败项" : "\n✅ 全部通过");
}

run().catch(e => { console.error("测试异常:", e); process.exit(1); });
