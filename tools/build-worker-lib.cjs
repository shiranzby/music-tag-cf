/**
 * 从 src/worker.js + src/worker_base.js 抽取音源 API，生成 lib/worker-sources.js（ESM）
 * 运行：node tools/build-worker-lib.cjs
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const worker = fs.readFileSync(path.join(root, "src/worker.js"), "utf8");
const base = fs.readFileSync(path.join(root, "src/worker_base.js"), "utf8");

// 按注释段边界抽取
function seg(from, to) {
  const a = worker.indexOf(from);
  const b = to ? worker.indexOf(to) : worker.length;
  if (a < 0 || b < 0 || b <= a) { console.error(`❌ 段定位失败: ${from}`); process.exit(1); }
  return worker.slice(a, b).trimEnd();
}

const netease = seg("// ─── NetEase Cloud Music API proxy", "// ─── QQ Music API proxy");
const qq = seg("// ─── QQ Music API proxy", "// ─── Deezer 官方公开 API");
const deezer = seg("// ─── Deezer 官方公开 API", "// ─── Combined search");
const both = seg("// ─── Combined search", "// ─── Worker-side metadata write");
const metaWrite = seg("// ─── Worker-side metadata write", "// ─── Cover image proxy");
const coverProxy = seg("// ─── Cover image proxy", "// ─── Album cover by song ID");
const albumCover = seg("// ─── Album cover by song ID", "// ─── Lyrics fetch proxy");
const lyrics = seg("// ─── Lyrics fetch proxy", "// ─── Main entry");

// worker_base.js 去掉 export 关键字（改为本文件内函数）
const baseCode = base
  .replace(/^\/\*\*[\s\S]*?\*\/\s*/m, "")
  .replace(/export function /g, "function ")
  .trim();

const banner = `/**
 * worker-sources.js — 音乐元数据 API（Cloudflare Worker 用，零外部依赖）
 * ========================================================================
 * 从 music-tag-cf 的 src/worker.js 自动抽取生成，请勿直接手改
 * （改 src/worker.js 后重新运行 node tools/build-worker-lib.cjs）
 *
 * 提供能力：
 *   GET  /api/tag/search?q=&source=netease|qq|deezer|both   三源音乐搜索
 *   GET  /api/cover/album?id=                                专辑封面 URL
 *   GET  /api/cover/proxy?url=                               封面图片代理（绕 CORS）
 *   GET  /api/lyrics/fetch?id=                               歌词代理
 *   POST /api/metadata/write                                 Worker 端元数据写入（可选 fallback）
 *
 * ── 接入方式（在宿主 Worker 的入口加一段） ──
 *   import { handleMusicApi } from "./worker-sources.js";
 *
 *   export default {
 *     async fetch(request, env, ctx) {
 *       // 1. 先让音乐 API 处理（返回 null 表示不是音乐路由，继续走你自己的）
 *       const r = await handleMusicApi(request);
 *       if (r) return r;
 *
 *       // 2. 你自己的路由 / 前端页面
 *       return new Response("...");
 *     },
 *   };
 *
 * ⚠️ 注意：这些是第三方非官方接口（网易云/QQ 为逆向网页接口，Deezer 为官方公开 API），
 *    随时可能失效。歌词只有网易云有；非网易云源需自行按「标题+艺术家」回退再搜。
 */

`;

const router = `
// ═══════════════════════════════════════════════════════════════════════════
//  路由表 + 统一入口
// ═══════════════════════════════════════════════════════════════════════════

/** 搜索路由：解析 q / source，做长度消毒 */
async function handleSearch(request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const source = url.searchParams.get("source") || "both";
  if (!query || query.trim().length === 0) return errorResponse("Missing 'q' parameter", 400);
  const sanitized = query.trim().slice(0, 200);
  switch (source) {
    case "netease": return searchNetEase(sanitized);
    case "qq":      return searchQQ(sanitized);
    case "deezer":  return searchDeezer(sanitized);
    case "both":
    default:        return searchBoth(sanitized);
  }
}

export const musicRoutes = {
  "/api/tag/search":     { GET: handleSearch },
  "/api/cover/album":    { GET: handleAlbumCover },
  "/api/cover/proxy":    { GET: handleCoverProxy },
  "/api/lyrics/fetch":   { GET: handleLyricsFetch },
  "/api/metadata/write": { POST: handleMetadataWrite },
};

/**
 * 音乐 API 统一入口。
 * @returns {Promise<Response|null>} null 表示该请求不属于音乐 API（宿主应继续处理）
 */
export async function handleMusicApi(request) {
  const pre = handlePreflight(request);
  if (pre) return pre;

  const url = new URL(request.url);
  const route = musicRoutes[url.pathname];
  if (!route) return null;

  const handler = route[request.method];
  if (!handler) return errorResponse("Method Not Allowed", 405);
  return handler(request, url);
}

export { searchNetEase, searchQQ, searchDeezer, searchBoth,
         handleCoverProxy, handleAlbumCover, handleLyricsFetch, handleMetadataWrite };
`;

const out = banner + baseCode + "\n\n" +
  netease + "\n\n" + qq + "\n\n" + deezer + "\n\n" + both + "\n\n" +
  coverProxy + "\n\n" + albumCover + "\n\n" + lyrics + "\n\n" +
  metaWrite + "\n" + router;

fs.writeFileSync(path.join(root, "lib", "worker-sources.js"), out);
console.log("✅ 已生成 lib/worker-sources.js：" + out.length + " 字节");
