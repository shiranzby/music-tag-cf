/**
 * worker.js — Music Tag Editor Cloudflare Worker
 *
 * Routes:
 *   GET  /                      → Serve frontend SPA
 *   GET  /api/tag/search?q=...  → Proxy music API search
 *   POST /api/metadata/write    → Worker-side metadata write (FLAC/MP4 fallback)
 */

import template from "./template.html";
import {
  corsHeaders,
  jsonResponse,
  errorResponse,
  handlePreflight,
} from "./worker_base.js";

// ─── NetEase Cloud Music API proxy ─────────────────────────────────────────

const NETEASE_SEARCH_URL = "https://music.163.com/api/search/get";
// Multiple UA strings — rotate on rate-limit to avoid IP throttling
const NETEASE_UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36",
];
let _neteaseUaIdx = 0;
// Simple in-memory cache (per Worker instance) — TTL 60s to reduce repeat API calls
const _searchCache = new Map();

function getCacheKey(query, source) {
  return `${source}:${query.toLowerCase().trim()}`;
}

async function searchNetEase(query) {
  const cacheKey = getCacheKey(query, "netease");
  const cached = _searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < 60000)) {
    return jsonResponse({ source: "netease", results: cached.results });
  }

  const url = `${NETEASE_SEARCH_URL}?s=${encodeURIComponent(query)}&type=1&limit=10&offset=0`;

  // Retry up to 2 times with different UAs on failure
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ua = NETEASE_UA_LIST[(_neteaseUaIdx + attempt) % NETEASE_UA_LIST.length];
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": ua, Referer: "https://music.163.com/" },
      });
      if (!resp.ok) {
        lastError = resp.status;
        if (attempt < 2) await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      const data = await resp.json();
      if (data.code !== 200 || !data.result?.songs) {
        lastError = data.code || "no_result";
        if (attempt < 2) await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      _neteaseUaIdx = (_neteaseUaIdx + 1) % NETEASE_UA_LIST.length;

      // Build results
      const songs = data.result.songs || [];
      const results = songs.map((song) => ({
        source: "netease",
        id: String(song.id),
        title: song.name || "",
        artist: (song.artists || []).map((a) => a.name).join("/"),
        album: (song.album || {}).name || "",
        albumId: String((song.album || {}).id || ""),
        duration: song.duration || 0,
        _albumPicId: (song.album || {}).picId || null,
        cover: null,
      }));

      // Cache successful results for 60s
      _searchCache.set(cacheKey, { results, time: Date.now() });
      return jsonResponse({ source: "netease", results });
    } catch (e) {
      lastError = e.message;
      if (attempt < 2) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }

  // All retries failed — return empty with error info
  if (lastError) console.error("NetEase search failed after retries:", lastError);
  return jsonResponse({ source: "netease", results: [] });
}

// ─── QQ Music API proxy ────────────────────────────────────────────────────

const QQ_SEARCH_URL = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
// Multiple User-Agent strings to try, rotating on failure
const QQ_UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQMusic/14.1.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
];
// Try multiple Referer strategies
const QQ_REFERERS = [
  "https://y.qq.com/",
  "https://i.y.qq.com/",
  "https://c.y.qq.com/",
];

async function searchQQ(query) {
  const url = `${QQ_SEARCH_URL}?w=${encodeURIComponent(query)}&format=json&n=10&p=1&t=0&aggr=1&lossless=1&cr=1`;

  // Try multiple UA/Referer combinations
  for (const ua of QQ_UA_LIST) {
    for (const ref of QQ_REFERERS.slice(0, 1)) { // Only try first referer per UA to reduce attempts
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": ua,
            Referer: ref,
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
        });

        if (!resp.ok) continue;

        let data;
        try {
          data = await resp.json();
        } catch (e) {
          continue;
        }

        const songs = data?.data?.song?.list || [];
        if (songs.length > 0) {
          const results = songs.map((song) => ({
            source: "qq",
            id: String(song.songmid || song.id),
            title: song.songname || song.title || "",
            artist: (song.singer || []).map((s) => s.name).join("/"),
            album: song.albumname || song.album || "",
            albumId: String(song.albummid || ""),
            // Multiple cover URL fallbacks (300x300, 500x500, 800x800)
            cover: song.albummid
              ? `https://y.qq.com/music/photo_new/T002R500x500M000${song.albummid}.jpg`
              : null,
            duration: song.interval || 0,
          }));

          return jsonResponse({ source: "qq", results });
        }
      } catch (e) {
        // Try next combination
        continue;
      }
    }
  }

  // All strategies failed — return empty with warning
  return jsonResponse({ source: "qq", results: [], hint: "QQ Music API blocked by anti-bot; try NetEase or Migu" });
}

// ─── Migu (咪咕) Music API proxy ──────────────────────────────────────────
//
// Migu has multiple API endpoints; we try them in order of likelihood.

const MIGU_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function searchMigu(query) {
  // Strategy 1: Mobile web search API
  let result = await _tryMiguEndpoint(
    `https://m.music.migu.cn/migu/remoting/scr_search_tag?keyword=${encodeURIComponent(query)}&type=2&pgc=1&rows=10`,
    { Referer: "https://m.music.migu.cn/", "User-Agent": MIGU_UA }
  );
  if (result) return result;

  // Strategy 2: Alternative API with different parameters
  result = await _tryMiguEndpoint(
    `https://m.music.migu.cn/migu/remoting/scr_search_tag?keyword=${encodeURIComponent(query)}&type=2&rows=10`,
    { Referer: "https://music.migu.cn/", "User-Agent": MIGU_UA }
  );
  if (result) return result;

  // Strategy 3: Web search API
  result = await _tryMiguEndpoint(
    `https://music.migu.cn/v3/api/search?keyword=${encodeURIComponent(query)}&type=2&page=1&size=10`,
    { Referer: "https://music.migu.cn/", "User-Agent": MIGU_UA }
  );
  if (result) return result;

  // Fallback: search via NetEase (which reliably works from CF edge)
  // Migu API is often geo-restricted; NetEase is more permissive
  return jsonResponse({ source: "migu", results: [], hint: "Migu API geo-restricted; use NetEase for best results" });
}

async function _tryMiguEndpoint(url, headers) {
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;

    const data = await resp.json();
    // Try multiple response paths
    const songs = data?.musics || data?.result?.musics || data?.data?.musics || data?.data?.list || [];
    if (songs.length === 0) return null;

    const results = songs.map((song) => ({
      source: "migu",
      id: String(song.copyrightId || song.songId || song.id || ""),
      title: song.songName || song.title || song.name || "",
      artist: [song.singerName || song.artist || ""].concat(
        (song.singers || []).map((s) => (typeof s === "string" ? s : s.name || s.singerName || ""))
      ).filter(Boolean).join("/"),
      album: song.albumName || song.album || "",
      albumId: String(song.albumId || ""),
      cover: song.cover || song.picM || song.pic || song.imgUrl || null,
      duration: song.duration || 0,
    }));

    if (results.length > 0) {
      return jsonResponse({ source: "migu", results });
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ─── Combined search (parallel fetch + merge) ──────────────────────────────

async function searchBoth(query) {
  const [neteaseResp, qqResp, miguResp] = await Promise.all([
    searchNetEase(query),
    searchQQ(query),
    searchMigu(query),
  ]);

  const neteaseJson = await neteaseResp.json();
  const qqJson = await qqResp.json();
  const miguJson = await miguResp.json();

  const results = [
    ...(neteaseJson.results || []),
    ...(qqJson.results || []),
    ...(miguJson.results || []),
  ];

  return jsonResponse({
    source: "combined",
    netease: neteaseJson.results || [],
    qq: qqJson.results || [],
    migu: miguJson.results || [],
    results,
  });
}

// ─── Worker-side metadata write (FLAC/MP4 fallback) ────────────────────────
//
// When browser-side ID3 write is insufficient (FLAC, MP4, etc.),
// the file can be uploaded here for server-side metadata modification.
// Limits: 100MB per file (Free plan), 30s CPU wall-clock.

async function handleMetadataWrite(request) {
  const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
  // Reject requests without Content-Length (likely chunked or streaming) to avoid
  // unbounded uploads that bypass the 100MB size check.
  if (!contentLength || isNaN(contentLength)) {
    return errorResponse("Content-Length header required", 411);
  }
  if (contentLength > 100 * 1024 * 1024) {
    return errorResponse("File exceeds 100MB limit", 413);
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return errorResponse("Expected multipart/form-data", 400);
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const metadataStr = formData.get("metadata");

    if (!file) return errorResponse("Missing file field", 400);
    if (!metadataStr) return errorResponse("Missing metadata field", 400);

    const metadata = JSON.parse(metadataStr);

    // Validate metadata field sizes (prevent OOM from oversized fields)
    for (const [key, val] of Object.entries(metadata)) {
      if (typeof val === "string" && val.length > 2048) {
        return errorResponse(`Metadata field "${key}" exceeds 2048 characters`, 400);
      }
    }

    const fileBuffer = await file.arrayBuffer();
    const fileName = file.name || "audio.mp3";

    // Determine format from extension
    const ext = fileName.split(".").pop().toLowerCase();
    let resultBuffer;

    switch (ext) {
      case "flac":
        resultBuffer = writeFLACMetadata(fileBuffer, metadata);
        break;
        case "m4a":
        case "mp4":
        case "alac":
          throw new Error("MP4/M4A metadata writing is not yet supported on the server. Please use MP3 format for now.");
        default:
        // For other formats (including MP3 fallback), use generic approach
        resultBuffer = fileBuffer;
    }

    const mimeTypes = {
      mp3: "audio/mpeg",
      flac: "audio/flac",
      m4a: "audio/mp4",
      mp4: "audio/mp4",
      wav: "audio/wav",
      ogg: "audio/ogg",
    };

    return new Response(resultBuffer, {
      status: 200,
      headers: {
        "Content-Type": mimeTypes[ext] || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
        ...corsHeaders(),
      },
    });
  } catch (err) {
    return errorResponse("Metadata write failed: " + err.message, 500);
  }
}

/**
 * Minimal FLAC metadata writer: replaces Vorbis Comment block.
 * FLAC structure: "fLaC" marker + STREAMINFO block + ... + VORBIS_COMMENT + ...
 * This is a simplified implementation that replaces the Vorbis Comment.
 */
function writeFLACMetadata(buffer, metadata) {
  const view = new DataView(buffer);
  const data = new Uint8Array(buffer);

  // Verify FLAC signature
  const sig = String.fromCharCode(...data.slice(0, 4));
  if (sig !== "fLaC") return buffer; // Not a FLAC file

  let offset = 4;
  let lastBlock = false;
  const blocks = [];

  // Parse existing metadata blocks
  while (!lastBlock && offset < data.length) {
    const header = view.getUint8(offset);
    lastBlock = !!(header & 0x80);
    const blockType = header & 0x7f;
    const blockSize =
      (view.getUint8(offset + 1) << 16) |
      (view.getUint8(offset + 2) << 8) |
      view.getUint8(offset + 3);

    blocks.push({
      lastBlock,
      type: blockType,
      offset: offset,
      size: blockSize,
      totalSize: 4 + blockSize, // header + data
    });

    offset += 4 + blockSize;
  }

  // Build Vorbis Comment with updated fields
  const vendorString = "music-tag-cf";
  const vendorEncoded = new TextEncoder().encode(vendorString);
  const vendorLen = vendorEncoded.length;

  const fields = [];
  if (metadata.title) fields.push(`TITLE=${metadata.title}`);
  if (metadata.artist) fields.push(`ARTIST=${metadata.artist}`);
  if (metadata.album) fields.push(`ALBUM=${metadata.album}`);
  if (metadata.year) fields.push(`DATE=${metadata.year}`);
  if (metadata.track) fields.push(`TRACKNUMBER=${metadata.track}`);
  if (metadata.genre) fields.push(`GENRE=${metadata.genre}`);
  if (metadata.comment) fields.push(`COMMENT=${metadata.comment}`);

  const commentCount = fields.length;
  const commentBytes = fields.map((f) => new TextEncoder().encode(f));
  const commentTotalSize = commentBytes.reduce((s, b) => s + 4 + b.length, 0);

  // Vorbis Comment block: type(1) + size(3) + vendor_length(4) + vendor + count(4) + comments
  const newCommentBlockSize =
    4 + vendorLen + 4 + commentTotalSize;
  const newCommentBlock = new Uint8Array(4 + newCommentBlockSize);

  newCommentBlock[0] = 0x04; // Block type 4 = Vorbis Comment, not last
  newCommentBlock[1] = (newCommentBlockSize >> 16) & 0xff;
  newCommentBlock[2] = (newCommentBlockSize >> 8) & 0xff;
  newCommentBlock[3] = newCommentBlockSize & 0xff;

  let pos = 4;
  // Vendor string
  new DataView(newCommentBlock.buffer).setUint32(pos, vendorLen, true);
  pos += 4;
  newCommentBlock.set(vendorEncoded, pos);
  pos += vendorLen;

  // Comment count
  new DataView(newCommentBlock.buffer).setUint32(pos, commentCount, true);
  pos += 4;

  // Comments
  for (const cb of commentBytes) {
    new DataView(newCommentBlock.buffer).setUint32(pos, cb.length, true);
    pos += 4;
    newCommentBlock.set(cb, pos);
    pos += cb.length;
  }

  // Replace old Vorbis Comment block
  const vorbisIdx = blocks.findIndex((b) => b.type === 4);
  if (vorbisIdx >= 0) {
    const oldBlock = blocks[vorbisIdx];
    const before = data.slice(0, oldBlock.offset);
    const after = data.slice(
      oldBlock.offset + oldBlock.totalSize,
    );

    // Update lastBlock flag: if old was last, new one should be last too
    if (oldBlock.lastBlock) {
      newCommentBlock[0] |= 0x80;
    }

    const result = new Uint8Array(
      before.length + newCommentBlock.length + after.length,
    );
    result.set(before);
    result.set(newCommentBlock, before.length);
    result.set(after, before.length + newCommentBlock.length);
    return result.buffer;
  }

  return buffer;
}

// ─── Cover image proxy ────────────────────────────────────────────────────
//
// Downloads cover image from a music platform URL and returns it as binary.
// This bypasses CORS restrictions that prevent the browser from fetching
// third-party images for canvas/Blob conversion.

async function handleCoverProxy(request) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");

  if (!targetUrl) {
    return errorResponse("Missing 'url' parameter", 400);
  }

  // Validate the URL is parseable
  try { new URL(targetUrl); } catch (e) {
    return errorResponse("Invalid URL", 400);
  }

  try {
    const resp = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MusicTagCF/1.0)",
        "Referer": "https://music.163.com/",
      },
    });

    if (!resp.ok) {
      return errorResponse("Cover image fetch failed", resp.status);
    }

    const contentType = resp.headers.get("Content-Type") || "image/jpeg";
    const imageBuffer = await resp.arrayBuffer();

    return new Response(imageBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=604800",
        ...corsHeaders(),
      },
    });
  } catch (e) {
    return errorResponse("Cover image fetch failed", 502);
  }
}

// ─── Album cover by song ID ────────────────────────────────────────────────
// Fetches album cover picUrl from NetEase song detail API using song ID.

async function handleAlbumCover(request) {
  const url = new URL(request.url);
  const songId = url.searchParams.get("id");
  if (!songId) return errorResponse("Missing 'id' parameter", 400);

  try {
    const detailUrl = `https://music.163.com/api/song/detail?ids=[${encodeURIComponent(songId)}]`;
    const resp = await fetch(detailUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://music.163.com/",
        "Accept": "application/json",
      },
    });
    if (!resp.ok) return errorResponse("NetEase API error", resp.status);

    const data = await resp.json();
    if (data.code !== 200 || !data.songs || data.songs.length === 0) {
      return errorResponse("Song not found", 404);
    }

    const picUrl = ((data.songs[0] || {}).album || {}).picUrl || ((data.songs[0] || {}).al || {}).picUrl;
    if (!picUrl) return errorResponse("No cover available", 404);

    return jsonResponse({ picUrl: picUrl + "?param=500y500" });
  } catch (e) {
    return errorResponse("Album cover fetch failed", 502);
  }
}

// ─── Lyrics fetch proxy ──────────────────────────────────────────────────
//
// Fetches lyrics from NetEase Cloud Music API.

async function handleLyricsFetch(request) {
  const url = new URL(request.url);
  const songId = url.searchParams.get("id");
  if (!songId) return errorResponse("Missing 'id' parameter", 400);

  try {
    const resp = await fetch(
      `https://music.163.com/api/song/lyric?id=${encodeURIComponent(songId)}&lv=1`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://music.163.com/",
        },
      }
    );

    if (!resp.ok) return errorResponse("Lyrics fetch failed", resp.status);

    const data = await resp.json();
    const lrc = data?.lrc?.lyric || data?.tlyric?.lyric || "";

    return jsonResponse({ lyrics: lrc });
  } catch (e) {
    return errorResponse("Lyrics fetch failed", 502);
  }
}

// ─── Main entry ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    const preflight = handlePreflight(request);
    if (preflight) return preflight;

    const url = new URL(request.url);
    const path = url.pathname;

    // Serve frontend
    if (path === "/" || path === "/index.html") {
      return new Response(template, {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
          ...corsHeaders(),
        },
      });
    }

    // ── API: Music tag search ──
    if (path === "/api/tag/search" && request.method === "GET") {
      const query = url.searchParams.get("q");
      const source = url.searchParams.get("source") || "both";

      if (!query || query.trim().length === 0) {
        return errorResponse("Missing 'q' parameter", 400);
      }

      // Sanitize: limit query length
      const sanitized = query.trim().slice(0, 200);

      switch (source) {
        case "netease":
          return searchNetEase(sanitized);
        case "qq":
          return searchQQ(sanitized);
        case "migu":
          return searchMigu(sanitized);
        case "yuanli_qq": case "yuanli_wy": case "yuanli_kg": case "yuanli_kw":
          return jsonResponse({ source, results: [], hint: "元力API需前端脚本加载。请在浏览器中使用。" });
        case "both":
        default:
          return searchBoth(sanitized);
      }
    }

    // ── API: Worker-side metadata write (fallback for non-MP3) ──
    if (path === "/api/metadata/write" && request.method === "POST") {
      return handleMetadataWrite(request);
    }

    // ── API: Cover image proxy ──
    if (path === "/api/cover/proxy" && request.method === "GET") {
      return handleCoverProxy(request);
    }

    // ── API: Album cover by picId ──
    if (path === "/api/cover/album" && request.method === "GET") {
      return handleAlbumCover(request);
    }

    // ── API: Lyrics fetch ──
    if (path === "/api/lyrics/fetch" && request.method === "GET") {
      return handleLyricsFetch(request);
    }

    // ── 404 ──
    return errorResponse("Not Found", 404);
  },
};
