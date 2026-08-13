// Vercel 文件系统路由 catch-all：捕获所有路径（含 /healthz、/v1/* 等），
// 且保持原始 URL 直达函数 —— worker.js 内部的路由逻辑据此正常工作。
// worker.js 导出的是带 fetch 方法的 Web handler，Vercel 运行时原生支持
// （@vercel/node >= 5 自动把 Node req/res 桥接为标准 Web Request/Response）。
import worker from "./worker.js";

export default worker;
