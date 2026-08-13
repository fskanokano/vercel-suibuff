#!/usr/bin/env node
/**
 * worker2vercel — 把 Cloudflare Worker 一键转换为 Vercel 兼容格式（最小改动）
 *
 * 转换原理（只做两处改动，业务逻辑零改动）：
 *   1. 把文件顶层的 `export default {` 替换为 `const __cfWorkerExport = {`
 *      （原导出对象原封不动，含 fetch / scheduled 等所有方法）
 *   2. 在文件末尾追加 Vercel 适配层：
 *      - envShim：自动收集 fetch 方法中引用的 env.<NAME> 变量，映射为
 *        process.env.<NAME>（变量名不变；未配置时为 undefined，与
 *        Cloudflare Worker 行为完全一致）
 *      - export default { fetch(request) { return __cfWorkerExport.fetch(request, envShim) } }
 *        Vercel Node 运行时（@vercel/node >= 5）原生识别该形态，自动把
 *        Node req/res 桥接为标准 Web Request/Response（SSE 无损）。
 *
 * 用法:
 *   node worker2vercel.mjs <input.js> [output.js] [--verify] [--in-place]
 *
 * 默认输出: 输入文件同目录下 <basename>.vercel.js
 * 选项:
 *   --verify   转换后尝试动态加载输出文件，验证语法与导出形态
 *   --in-place 直接覆盖输入文件（谨慎）
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ENV_PARAM = "env";
const MARKER = "__cfWorkerExport";

// ---------- 括号配平（跳过字符串 / 模板字符串 / 注释） ----------
function findMatchingBrace(src, openIdx) {
  const n = src.length;
  let depth = 0;
  let i = openIdx;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === q) { i++; break; }
        else i++;
      }
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "`") { i++; break; }
        else if (src[i] === "$" && src[i + 1] === "{") {
          const end = findMatchingBrace(src, i + 1); // 模板插值递归配平
          if (end < 0) return -1;
          i = end + 1;
        }
        else i++;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// ---------- 提取 fetch 方法定义的第二个形参名（默认 env） ----------
// 支持三种形态:
//   fetch(request, env) { ... }                        （对象方法简写）
//   fetch: async function (request, env) { ... }        （属性函数）
//   fetch: async (request, env) => { ... }              （属性箭头函数）
function extractEnvParam(objBody) {
  const re = /\bfetch\s*(?::\s*(?:async\s+)?function)?\s*\(\s*([^)]*?)\)\s*(?:\{|=>)/s;
  const m = objBody.match(re);
  if (!m) return DEFAULT_ENV_PARAM;
  const parts = m[1].split(",");
  if (parts.length < 2) return DEFAULT_ENV_PARAM;
  const second = parts[1].trim().replace(/=.*$/, "").trim(); // 去掉默认值
  const id = second.match(/^[A-Za-z_$][\w$]*/);
  return id ? id[0] : DEFAULT_ENV_PARAM;
}

// ---------- 收集 env 变量名 ----------
// 在【整个文件】范围收集：fetch 方法体可能只把 env 传给外部函数，
// 实际引用 env.XXX 的函数（parseAccounts / getApiKey 等）通常在 export 对象外。
// 注释/字符串里的误收集无害（多一个 envShim 字段，可手动删减）。
function collectEnvVars(source, param) {
  const vars = new Set();
  const add = (v) => { if (v) vars.add(v); };
  for (const m of source.matchAll(new RegExp(`\\b${param}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g"))) add(m[1]);
  for (const m of source.matchAll(new RegExp(`\\b${param}\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]`, "g"))) add(m[1]);
  // 兜底：绝大多数 worker 形参就叫 env，再收集 env.XXX（Set 自动去重）
  if (param !== DEFAULT_ENV_PARAM) {
    for (const m of source.matchAll(new RegExp(`\\b${DEFAULT_ENV_PARAM}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g"))) add(m[1]);
  }
  return [...vars].sort();
}

// ---------- 主转换 ----------
function convert(src) {
  // 防重复转换
  if (new RegExp(`\\bconst\\s+${MARKER}\\s*=`).test(src) && /envShim\s*=/.test(src)) {
    throw new Error("文件已是 Vercel 兼容格式（检测到 __cfWorkerExport 适配层），无需转换");
  }
  if (/envShim\s*=/.test(src) && /workerFetch/.test(src)) {
    throw new Error("文件已是 Vercel 兼容格式（检测到 envShim/workerFetch），无需转换");
  }

  const exportRe = /\bexport\s+default\s*(\/\*[\s\S]*?\*\/\s*)?\{/;
  const m = exportRe.exec(src);
  if (!m) {
    throw new Error("未找到 `export default {` —— 仅支持该形态的 Cloudflare Worker（不支持 addEventListener / module.exports 旧格式）");
  }
  const openIdx = m.index + m[0].length - 1; // m[0] 以 `{` 结尾
  const closeIdx = findMatchingBrace(src, openIdx);
  if (closeIdx < 0) {
    throw new Error("无法配平 export default 对象的花括号（文件可能有语法错误，或含正则字面量）");
  }

  const objBody = src.slice(openIdx, closeIdx + 1);
  const param = extractEnvParam(objBody);
  const envVars = collectEnvVars(src, param); // 全文件范围收集

  // 改动 1：`export default {` → `const __cfWorkerExport = {`（对象体原样保留）
  const replaced = src.slice(0, m.index)
    + `const ${MARKER} = {`
    + src.slice(openIdx + 1, closeIdx + 1)
    + src.slice(closeIdx + 1);

  // 改动 2：文件末尾追加 Vercel 适配层
  const envFields = envVars.length
    ? envVars.map((v) => `  ${v}: process.env.${v},`).join("\n")
    : "  // （未检测到 env 变量引用；如需环境变量请在此手动添加）";

  const adapter = `

// ============================================================
// Vercel 适配层 — 由 worker2vercel 自动生成（业务逻辑零改动）
// ============================================================
// 说明：
//  - Vercel Node 运行时（@vercel/node >= 5）原生识别 export default { fetch(request) }
//    形态，自动把 Node req/res 桥接为标准 Web Request/Response（SSE 无损）。
//  - Vercel 调用 fetch 只传 request（不传 env），因此用 process.env 构造等价 env。
//  - 环境变量名与原 Cloudflare Worker 完全一致，在 Vercel 项目
//    Settings → Environment Variables 配置同名变量即可。
//  - 未配置的变量为 undefined，与 Cloudflare Worker 行为一致。
const envShim = {
${envFields}
};

export default {
  async fetch(request) {
    return ${MARKER}.fetch(request, envShim);
  },
};
`;
  return replaced + adapter;
}

function usage() {
  console.log(`用法: node worker2vercel.mjs <input.js> [output.js] [--verify] [--in-place]

  默认输出: 输入文件同目录下 <basename>.vercel.js
  --verify   转换后尝试动态加载，验证语法与导出形态
  --in-place 直接覆盖输入文件`);
}

async function main() {
  const args = process.argv.slice(2);
  const opts = { verify: false, inPlace: false };
  const positional = [];
  for (const a of args) {
    if (a === "--verify") opts.verify = true;
    else if (a === "--in-place") opts.inPlace = true;
    else positional.push(a);
  }
  if (positional.length < 1) { usage(); process.exit(1); }

  const input = resolve(positional[0]);
  let src;
  try { src = readFileSync(input, "utf8"); }
  catch { console.error(`错误: 无法读取文件 ${input}`); process.exit(1); }

  let out;
  try { out = convert(src); }
  catch (e) { console.error(`转换失败: ${e.message}`); process.exit(1); }

  let outputPath;
  if (opts.inPlace) outputPath = input;
  else if (positional[1]) outputPath = resolve(positional[1]);
  else {
    const dir = dirname(input);
    const base = basename(input, extname(input));
    outputPath = join(dir, `${base}.vercel.js`);
  }
  writeFileSync(outputPath, out);
  console.log(`✅ 转换完成: ${outputPath}`);

  if (opts.verify) {
    try {
      const mod = await import(pathToFileURL(outputPath).href + "?v=" + Date.now());
      const listener = mod.default && typeof mod.default === "object" ? mod.default : mod;
      if (listener && typeof listener.fetch === "function") {
        console.log("✅ 验证通过: 导出形态为 { fetch(request) }，Vercel 运行时可识别");
      } else {
        console.error(`❌ 验证失败: 输出文件导出形态异常 (${typeof listener})`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`❌ 验证失败: 无法加载输出文件 — ${e.message}`);
      process.exit(1);
    }
  }
}

await main();
