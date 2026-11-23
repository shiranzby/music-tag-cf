/**
 * 从 src/template.html 抽取核心标签库，生成 lib/music-tag.js（ESM，无 DOM 依赖）
 * 运行：node tools/build-lib.cjs
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/template.html"), "utf8");

const s = html.indexOf("const ID3 = {};");
const e = html.indexOf("  Application State & Logic");
if (s < 0 || e < 0) { console.error("❌ 定位失败"); process.exit(1); }
let core = html.slice(s, e);
core = core.slice(0, core.lastIndexOf("// ═"));

// DOM 依赖硬校验：核心库必须是纯二进制逻辑
const domHits = ["document.", "window.", "localStorage", "addEventListener", "querySelector", "getElementById", "innerHTML"];
const domFound = domHits.filter(d => core.includes(d));
if (domFound.length) { console.error("❌ 核心段含 DOM 依赖:", domFound.join(",")); process.exit(1); }

const banner = `/**
 * music-tag.js — 浏览器端音乐标签库（零依赖 / 无 DOM）
 * =====================================================
 * 从 music-tag-cf 的 template.html 自动抽取生成，请勿直接手改
 * （改 src/template.html 后重新运行 node tools/build-lib.cjs）
 *
 * 支持格式：MP3(ID3v2.2/2.3/2.4) / FLAC / M4A(MP4) / OGG / WAV
 *
 * ── 快速上手 ──
 *   import { MusicTag, LRC } from "./music-tag.js";
 *
 *   // 1. 读取本地文件
 *   const buf = await file.arrayBuffer();
 *   const info = MusicTag.read(buf);
 *   info.format            // "mp3" | "flac" | "m4a" | "ogg" | "wav" | null
 *   info.metadata.title    // 标题（字段全部为小写：title/artist/album/albumArtist/
 *                          //   composer/year/track/disc/genre/comment/lyrics）
 *   info.cover             // { mime, data: Uint8Array } | null
 *   info.audioInfo         // { bitrate, sampleRate, channels, bitDepth } | null
 *
 *   // 2. 写回标签（info 原样传回，内部携带格式状态）
 *   const out = MusicTag.write(buf, { title: "新标题", lyrics: "[00:01.00]歌词" }, info);
 *   // out 是 ArrayBuffer，可直接存 Blob 播放/下载
 *
 *   // 3. 歌词逐行同步
 *   LRC.lineAt(info.metadata.lyrics, audio.currentTime);
 *
 * ── 独立解析器（高级用法） ──
 *   ID3.read/write · FLAC.read/write · M4A.read/write · OGG.read/write · WAV.read/write
 */

`;

const lrcModule = `
// ═══════════════════════════════════════════════════════════════════════════
//  LRC 歌词解析（播放器逐行同步用）
// ═══════════════════════════════════════════════════════════════════════════

export const LRC = {
  /**
   * 解析 LRC 文本为 [{ time(秒), text }]
   * 支持 [mm:ss.xx] / [mm:ss.xxx] / [mm:ss] 三种时间标签，一行可含多个时间标签
   */
  parse(text) {
    if (!text) return [];
    const out = [];
    for (const raw of String(text).split("\\n")) {
      const line = raw.trim();
      if (!line) continue;
      const re = /\\[(\\d{1,3}):(\\d{2})(?:[.:](\\d{1,3}))?\\]/g;
      let m, stamps = [];
      while ((m = re.exec(line)) !== null) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        const ms = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) / 1000 : 0;
        stamps.push(min * 60 + sec + ms);
      }
      if (!stamps.length) continue;
      const lyric = line.slice(line.lastIndexOf("]") + 1).trim();
      for (const t of stamps) out.push({ time: t, text: lyric });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  },

  /** 取 currentSec 时刻应显示的歌词行（无匹配返回 ""） */
  lineAt(text, currentSec) {
    const lines = LRC.parse(text);
    if (!lines.length) return "";
    let cur = "";
    for (const l of lines) {
      if (l.time <= currentSec) cur = l.text;
      else break;
    }
    return cur;
  },
};
`;

const facade = `
// ═══════════════════════════════════════════════════════════════════════════
//  统一门面：格式识别 + 读写（播放器只需用这两个方法）
// ═══════════════════════════════════════════════════════════════════════════

const METADATA_FIELDS = ["title","artist","album","albumArtist","composer",
  "year","track","disc","genre","comment","lyrics"];

export const MusicTag = {
  /** 识别音频格式，返回 "mp3"|"flac"|"m4a"|"ogg"|"wav"|null */
  detect(buffer) {
    if (!buffer || buffer.byteLength < 12) return null;
    const u8 = new Uint8Array(buffer);
    if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return "mp3";            // "ID3"
    if (u8[0] === 0x66 && u8[1] === 0x4C && u8[2] === 0x61 && u8[3] === 0x43) return "flac"; // "fLaC"
    if (M4A._boxType(u8, 4) === "ftyp") return "m4a";
    if (u8[0] === 0x4F && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53) return "ogg";  // "OggS"
    if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) return "wav";  // "RIFF"
    return null;
  },

  /**
   * 读取标签。返回统一结构：
   * { format, metadata, cover, audioInfo, writable, raw }
   *   raw 为各解析器的原始结果，写回时原样传给 MusicTag.write 的第三参
   */
  read(buffer) {
    const format = MusicTag.detect(buffer);
    if (!format) return { format: null, metadata: null, cover: null, audioInfo: null, writable: false, raw: null };

    let raw = null, metadata = null, cover = null, audioInfo = null;
    if (format === "mp3") {
      raw = ID3.read(buffer);
      if (raw) { metadata = raw.frames; cover = raw.cover; audioInfo = ID3._parseMP3Info(buffer); }
    } else if (format === "flac") {
      raw = FLAC.read(buffer);
      if (raw) { metadata = raw.metadata; cover = raw.cover; audioInfo = raw.streamInfo; }
    } else if (format === "m4a") {
      raw = M4A.read(buffer);
      if (raw) { metadata = raw.metadata; }
    } else if (format === "ogg") {
      raw = OGG.read(buffer);
      if (raw) { metadata = raw.metadata; }
    } else if (format === "wav") {
      raw = WAV.read(buffer);
      if (raw) { metadata = raw.metadata; }
    }

    // 归一化：保证 11 个标准字段都存在（空串），避免调用方判 undefined
    if (metadata) {
      const norm = {};
      for (const k of METADATA_FIELDS) norm[k] = metadata[k] || "";
      metadata = norm;
    }
    return { format, metadata, cover, audioInfo, writable: !!raw, raw };
  },

  /**
   * 写回标签。tags 只需给要改的字段；info 为 MusicTag.read 的返回值。
   * 返回新 ArrayBuffer；格式不支持时原样返回入参 buffer。
   */
  write(buffer, tags, info) {
    const format = (info && info.format) || MusicTag.detect(buffer);
    if (!format || !info || !info.raw) return buffer;
    if (format === "mp3")  return ID3.write(buffer, tags, info.raw);
    if (format === "flac") return FLAC.write(buffer, tags, info.raw);
    if (format === "m4a")  return M4A.write(buffer, tags, info.raw);
    if (format === "ogg")  return OGG.write(buffer, tags, info.raw);
    if (format === "wav")  return WAV.write(buffer, tags, info.raw);
    return buffer;
  },
};

export { ID3, FLAC, M4A, OGG, WAV };
`;

const out = banner + core + lrcModule + facade;
fs.mkdirSync(path.join(root, "lib"), { recursive: true });
fs.writeFileSync(path.join(root, "lib", "music-tag.js"), out);
console.log("✅ 已生成 lib/music-tag.js：" + out.length + " 字节");
