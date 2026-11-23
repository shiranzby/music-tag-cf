/**
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

const ID3 = {};

/**
 * Read a synchsafe integer (4 bytes where each byte uses only 7 bits).
 */
ID3.readSynchSafe = function(view, offset) {
  return (view.getUint8(offset)     << 21) |
         (view.getUint8(offset + 1) << 14) |
         (view.getUint8(offset + 2) << 7)  |
         view.getUint8(offset + 3);
};

/**
 * Write a synchsafe integer.
 */
ID3.writeSynchSafe = function(value) {
  const buf = new Uint8Array(4);
  buf[0] = (value >> 21) & 0x7f;
  buf[1] = (value >> 14) & 0x7f;
  buf[2] = (value >> 7)  & 0x7f;
  buf[3] = value & 0x7f;
  return buf;
};

/**
 * Decode text from ID3v2 frame data.
 * Strategy: try UTF-8 first (most common), then declared encoding, then fallbacks.
 * This handles the common case where encoding byte is wrong but data is UTF-8.
 */
ID3.decodeText = function(data) {
  if (!data || data.length === 0) return "";
  const code = data[0];
  let bytes = data.slice(1);
  if (bytes.length === 0) return "";

  // Some encoders prepend an extra 0x00 before a UTF-16 BOM — strip it
  if (bytes.length >= 3 && bytes[0] === 0x00 &&
      ((bytes[1] === 0xFF && bytes[2] === 0xFE) || (bytes[1] === 0xFE && bytes[2] === 0xFF))) {
    bytes = bytes.slice(1);
  }

  // When encoding byte says UTF-16, trust it (avoid NUL-interleaved false UTF-8 decode)
  // Also try both LE and BE — some encoders write BE data with LE encoding byte.
  if (code === 0x01) {
    try {
      const leResult = new TextDecoder("utf-16").decode(bytes);
      if (!leResult.includes("\0")) return leResult;
      return new TextDecoder("utf-16be").decode(bytes);
    } catch (e) {}
  }
  if (code === 0x02) {
    try {
      const beResult = new TextDecoder("utf-16be").decode(bytes);
      if (!beResult.includes("\0")) return beResult;
      return new TextDecoder("utf-16").decode(bytes);
    } catch (e) {}
  }

  // Always try UTF-8 first — most modern MP3s use it regardless of encoding byte
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) {}

  // UTF-8 didn't work — try the declared encoding
  try {
    if (code === 0x03) return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {}

  // Try Chinese encodings
  try { return new TextDecoder("gbk", { fatal: true }).decode(bytes); } catch (e) {}
  try { return new TextDecoder("big5", { fatal: true }).decode(bytes); } catch (e) {}

  // Ultimate fallback: Latin-1 byte-by-byte
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return str;
};

/**
 * Encode text for ID3v2 frame using UTF-8 (encoding byte 0x03).
 * Returns Uint8Array: [0x03, ...UTF-8 bytes].
 */
ID3.encodeText = function(text) {
  const utf8 = new TextEncoder().encode(text || "");
  const result = new Uint8Array(1 + utf8.length);
  result[0] = 0x03; // UTF-8
  result.set(utf8, 1);
  return result;
};

/**
 * Parse ID3v2 tags from an ArrayBuffer.
 * Returns { frames: { TIT2: "Title", TPE1: "Artist", ... }, cover: { mime, data } | null }
 * Returns null if no ID3v2 tag found.
 */
ID3.read = function(buffer) {
  if (!buffer || buffer.byteLength < 10) return null;

  const view = new DataView(buffer);
  const data = new Uint8Array(buffer);

  // Check ID3v2 signature
  if (data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) {
    return null; // "ID3"
  }

  const version = data[3];
  if (version < 2 || version > 4) return null; // Only v2.2-v2.4

  const flags = data[5];
  const hasFooter = !!(flags & 0x10); // v2.4 footer flag
  const hasExtended = !!(flags & 0x40); // Extended header present
  const tagSize = ID3.readSynchSafe(view, 6);

  let offset = 10; // After header

  // Skip extended header if present (v2.3 and v2.4)
  if (hasExtended) {
    // Extended header: 4-byte synchsafe size (does NOT include these 4 bytes in v2.3)
    const extSize = ID3.readSynchSafe(view, offset);
    offset += 4;
    if (version === 4) {
      // In v2.4, size includes the 4 bytes we just read
      offset += Math.max(0, extSize - 4);
    } else {
      offset += extSize;
    }
  }

  const tagEnd = offset + tagSize;

  const result = { frames: {}, cover: null, tagSize: tagSize + 10 + (hasFooter ? 10 : 0), version, _rawFrames: [] };

  // Iterate frames
  while (offset < tagEnd - 10) {
    // v2.2 uses 3-byte frame IDs, v2.3/v2.4 use 4-byte
    const frameId = version === 2
      ? String.fromCharCode(data[offset], data[offset + 1], data[offset + 2])
      : String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);

    // Stop at padding (null frame ID)
    if (frameId.charCodeAt(0) === 0) break;

    let frameSize, frameFlags;

    if (version === 2) {
      // ID3v2.2: 3-byte frame ID (already read at offset..offset+2), 3-byte size at offset+3..offset+5
      frameSize = (data[offset + 3] << 16) | (data[offset + 4] << 8) | data[offset + 5];
      frameFlags = 0;
      offset += 6; // Skip past 3-byte ID + 3-byte size
    } else {
      // ID3v2.3/2.4: 4-byte frame ID, 4-byte size, 2-byte flags (ID was read from bytes before offset)
      frameSize = (version === 4)
        ? ID3.readSynchSafe(view, offset + 4)
        : view.getUint32(offset + 4);
      frameFlags = view.getUint16(offset + 8);
      offset += 10;
    }

    // Zero or negative size = skip
    if (frameSize <= 0) break;

    const frameData = data.slice(offset, offset + frameSize);
    offset += frameSize;

    // 保留原始帧副本：写入时对「未被管理的帧」原样透传，避免重写标签丢信息
    if (frameId.length >= 3 && frameId.charCodeAt(0) !== 0) {
      result._rawFrames.push({ id: frameId, data: frameData });
    }

    // Extract frame content
    if (frameId === "APIC" || frameId === "PIC") {
      // Attached picture
      try {
        const enc = frameData[0];
        let pos = 1;

        // MIME type
        let mime = "";
        while (pos < frameData.length && frameData[pos] !== 0) {
          mime += String.fromCharCode(frameData[pos]);
          pos++;
        }
        pos++; // Skip null

        // Picture type (skip)
        pos++; // picType = frameData[pos];

        // Description
        while (pos < frameData.length && frameData[pos] !== 0) pos++;
        pos++; // Skip null

        // Image data
        const imgData = frameData.slice(pos);
        result.cover = {
          mime: mime || "image/jpeg",
          data: imgData
        };
        // Preserve raw frame for lossless re-write
        result._coverFrameData = frameData;
      } catch (e) { /* ignore malformed APIC */ }
    } else if (frameId === "TIT2" || frameId === "TT2") {
      result.frames.title = ID3.decodeText(frameData);
    } else if (frameId === "TPE1" || frameId === "TP1") {
      result.frames.artist = ID3.decodeText(frameData);
    } else if (frameId === "TALB" || frameId === "TAL") {
      result.frames.album = ID3.decodeText(frameData);
    } else if (frameId === "TYER" || frameId === "TYE" || frameId === "TDRC") {
      result.frames.year = ID3.decodeText(frameData);
    } else if (frameId === "TRCK" || frameId === "TRK") {
      result.frames.track = ID3.decodeText(frameData);
    } else if (frameId === "TCON" || frameId === "TCO") {
      result.frames.genre = ID3.decodeText(frameData);
    } else if (frameId === "COMM" || frameId === "COM") {
      // COMM: encoding(1)+lang(3)+desc(null)+text
      let descEnd = 4;
      while (descEnd < frameData.length && frameData[descEnd] !== 0) descEnd++;
      if (descEnd + 1 < frameData.length) {
        result.frames.comment = ID3.decodeAny(frameData.slice(descEnd + 1));
      }
    } else if (frameId === "TPOS" || frameId === "TPA") {
      result.frames.disc = ID3.decodeText(frameData);       // "1/2" format
    } else if (frameId === "TCOM" || frameId === "TCM") {
      result.frames.composer = ID3.decodeText(frameData);
    } else if (frameId === "TPE2" || frameId === "TP2") {
      result.frames.albumArtist = ID3.decodeText(frameData);
    } else if (frameId === "USLT" || frameId === "ULT") {
      // USLT: encoding(1)+lang(3)+desc(null)+lyrics
      const encByte = frameData[0];
      let descEnd = 4;
      while (descEnd < frameData.length && frameData[descEnd] !== 0) descEnd++;
      if (descEnd + 1 < frameData.length) {
        result.frames.lyrics = ID3.decodeAny(frameData.slice(descEnd + 1), encByte);
      }
    } else if (frameId === "TXXX" || frameId === "TXX") {
      // Custom text frame: encoding(1)+desc(null)+value
      let dEnd = 1;
      while (dEnd < frameData.length && frameData[dEnd] !== 0) dEnd++;
      if (dEnd + 1 < frameData.length) {
        const desc = ID3.decodeAny(frameData.slice(1, dEnd));
        const val = ID3.decodeAny(frameData.slice(dEnd + 1));
        if (desc.toUpperCase() === "LYRICS" || desc.toUpperCase() === "UNSYNCEDLYRICS") {
          if (!result.frames.lyrics) result.frames.lyrics = val;
        }
      }
    } else if (frameId === "SYLT") {
      // Synchronized lyrics: skip timing and just extract text
      // SYLT: encoding(1)+lang(3)+timestamp(1)+type(1)+count(4)+descriptor(null)+pairs...
      // For now just signal presence
      result.frames._hasSYLT = true;
    }
  }

  return result;
};

/**
 * Universal text decoder — tries UTF-8, detects BOM for UTF-16, then GBK/Big5/Latin-1.
 * No reliance on encoding byte. Handles all real-world cases.
 * @param {Uint8Array} bytes - Raw bytes to decode
 * @param {number} [encByte] - Optional ID3 encoding byte (0x00=Latin1, 0x01=UTF16LE, 0x02=UTF16BE, 0x03=UTF8)
 */
ID3.decodeAny = function(bytes, encByte) {
  if (!bytes || bytes.length === 0) return "";

  // Some encoders prepend an extra 0x00 before a UTF-16 BOM — strip it
  if (bytes.length >= 3 && bytes[0] === 0x00 &&
      ((bytes[1] === 0xFF && bytes[2] === 0xFE) || (bytes[1] === 0xFE && bytes[2] === 0xFF))) {
    bytes = bytes.slice(1);
  }

  // When encoding byte explicitly indicates UTF-16, try UTF-16 before UTF-8
  // to avoid the "UTF-8 succeeds on NUL-interleaved UTF-16LE data" issue.
  // Also try both LE and BE — some encoders write BE data with LE encoding byte.
  if (encByte === 0x01) {
    try {
      if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE)
        return new TextDecoder("utf-16").decode(bytes);
      if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF)
        return new TextDecoder("utf-16be").decode(bytes);
      // No BOM: try LE first (per ID3v2 spec)
      const leResult = new TextDecoder("utf-16").decode(bytes);
      // Check if the result looks reasonable (not all CJK when the file title is English)
      const hasNul = leResult.includes("\0");
      if (!hasNul) return leResult;
      // Has NUL interleaved - probably wrong endianness, try BE
      return new TextDecoder("utf-16be").decode(bytes);
    } catch (e) { /* fall through */ }
  }
  if (encByte === 0x02) {
    try {
      if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF)
        return new TextDecoder("utf-16be").decode(bytes);
      if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE)
        return new TextDecoder("utf-16").decode(bytes);
      // No BOM: try BE first
      const beResult = new TextDecoder("utf-16be").decode(bytes);
      const hasNul = beResult.includes("\0");
      if (!hasNul) return beResult;
      return new TextDecoder("utf-16").decode(bytes);
    } catch (e) { /* fall through */ }
  }

  // Default: UTF-8 first (covers most modern MP3s regardless of wrong encoding byte),
  // then BOM detection, then Chinese encodings, then Latin-1 fallback
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) {}
  if (bytes.length >= 2) {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder("utf-16").decode(bytes);
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder("utf-16be").decode(bytes);
  }
  try { return new TextDecoder("gbk", { fatal: true }).decode(bytes); } catch (e) {}
  try { return new TextDecoder("big5", { fatal: true }).decode(bytes); } catch (e) {}
  let str2 = "";
  for (let i = 0; i < bytes.length; i++) str2 += String.fromCharCode(bytes[i]);
  return str2;
};

/**
 * ID3v2.2 三字节帧 ID → ID3v2.3 四字节帧 ID 映射。
 * 用于写入(v2.3)时把老帧号的原始帧正确透传。
 */
ID3._v22Map = {
  TT2: "TIT2", TP1: "TPE1", TP2: "TPE2", TCM: "TCOM", TAL: "TALB",
  TYE: "TYER", TRK: "TRCK", TPA: "TPOS", TCO: "TCON", COM: "COMM",
  ULT: "USLT", TXX: "TXXX", PIC: "APIC",
};

/** 已被本编辑器重建/管理的帧 ID —— 这些不参与透传，避免重复 */
ID3._managedFrameIds = ["TIT2","TPE1","TPE2","TCOM","TALB","TYER","TDRC","TRCK",
  "TPOS","TCON","COMM","USLT","APIC","PIC"];

/**
 * Write ID3v2.3 tags to an ArrayBuffer.
 * @param {ArrayBuffer} buffer - Original file buffer
 * @param {object} tags - { title, artist, album, year, track, genre, comment }
 * @param {object} originalId3 - Result from ID3.read() to get original tag size
 * @returns {ArrayBuffer} - New buffer with updated ID3 tag
 */
ID3.write = function(buffer, tags, originalId3) {
  const data = new Uint8Array(buffer);

  // Collect frames to write
  const frames = [];
  if (tags.title)       frames.push(ID3._makeFrame("TIT2", tags.title));
  if (tags.artist)      frames.push(ID3._makeFrame("TPE1", tags.artist));
  if (tags.albumArtist) frames.push(ID3._makeFrame("TPE2", tags.albumArtist));
  if (tags.composer)    frames.push(ID3._makeFrame("TCOM", tags.composer));
  if (tags.album)       frames.push(ID3._makeFrame("TALB", tags.album));
  if (tags.year)        frames.push(ID3._makeFrame("TYER", tags.year));
  if (tags.track)       frames.push(ID3._makeFrame("TRCK", tags.track));
  if (tags.disc)        frames.push(ID3._makeFrame("TPOS", tags.disc));
  if (tags.genre)       frames.push(ID3._makeFrame("TCON", tags.genre));
  if (tags.comment)     frames.push(ID3._makeFrame("COMM", tags.comment));
  if (tags.lyrics)      frames.push(ID3._makeLyricsFrame("USLT", tags.lyrics));

  // Cover art: use new cover if provided, otherwise passthrough original
  if (tags._newCover) {
    // New cover provided as { mime, data: Uint8Array }
    frames.push(ID3._makeCoverFrame("APIC", tags._newCover.mime, tags._newCover.data));
  } else if (tags._removeCover) {
    // Explicitly removed cover — don't include APIC frame
  } else if (originalId3 && originalId3._coverFrameData && originalId3.version >= 3) {
    // Passthrough original cover (v2.3+ APIC format)
    frames.push(ID3._wrapRawFrame("APIC", originalId3._coverFrameData));
  } else if (originalId3 && originalId3._coverFrameData && originalId3.version < 3) {
    // v2.2 PIC → convert to v2.3 APIC: map 3-byte MIME to standard format
    const picData = originalId3._coverFrameData;
    if (picData.length >= 5) {
      const mime3 = String.fromCharCode(picData[1], picData[2], picData[3]);
      const mimeFull = mime3 === "JPG" ? "image/jpeg" : mime3 === "PNG" ? "image/png" : "image/jpeg";
      let descEnd = 5;
      while (descEnd < picData.length && picData[descEnd] !== 0) descEnd++;
      const imgData = picData.slice(descEnd + 1);
      if (imgData.length > 0) {
        frames.push(ID3._makeCoverFrame("APIC", mimeFull, imgData));
      }
    }
  }

  // 透传未被管理的原始帧：保留 PRIV/GEOB/POPM/TBPM/WOAR 等本编辑器未处理的标签，
  // 避免「保存一次 → 原文件信息被清空」。v2.2 三字节帧号按映射表转 v2.3。
  // 注意：TDRC(v2.4 日期)属被管理帧，其语义由 v2.3 的 TYER 承载，不透传以免重复。
  if (originalId3 && originalId3._rawFrames) {
    const managed = new Set(ID3._managedFrameIds);
    for (const rf of originalId3._rawFrames) {
      let fid = rf.id;
      if (fid.length === 3) fid = ID3._v22Map[fid] || "";
      if (fid.length !== 4) continue;          // 无法映射的老帧号 → 丢弃（防止结构损坏）
      if (managed.has(fid) || managed.has(rf.id)) continue; // 已被重建 → 不重复
      try {
        frames.push(ID3._wrapRawFrame(fid, rf.data));
      } catch (e) { /* 单帧透传失败不影响整体 */ }
    }
  }

  // Calculate total frame size
  let framesSize = 0;
  for (const f of frames) framesSize += f.length;

  // Add 1024 bytes padding
  const paddingSize = 1024;
  const tagBodySize = framesSize + paddingSize;

  // Create ID3v2.3 header (10 bytes)
  const header = new Uint8Array(10);
  header[0] = 0x49; header[1] = 0x44; header[2] = 0x33; // "ID3"
  header[3] = 0x03; header[4] = 0x00; // Version 2.3
  header[5] = 0x00; // Flags
  const sizeBytes = ID3.writeSynchSafe(tagBodySize);
  header.set(sizeBytes, 6);

  // Build new tag
  const newTag = new Uint8Array(10 + framesSize + paddingSize);
  newTag.set(header, 0);
  let pos = 10;
  for (const f of frames) {
    newTag.set(f, pos);
    pos += f.length;
  }
  // Padding (zeros)
  for (let i = pos; i < newTag.length; i++) newTag[i] = 0;

  // Determine audio start
  let audioStart = 0;
  if (originalId3 && originalId3.tagSize > 0) {
    audioStart = originalId3.tagSize;
  }

  const audioData = data.slice(audioStart);
  const result = new Uint8Array(newTag.length + audioData.length);
  result.set(newTag);
  result.set(audioData, newTag.length);

  return result.buffer;
};

/**
 * Make a single ID3v2.3 frame (10-byte header + body).
 */
ID3._makeFrame = function(id, value) {
  const body = ID3.encodeText(value);
  // For COMM frame, prepend language + description (no extra encoding byte in text)
  let frameBody;
  if (id === "COMM") {
    // encoding(1) + "eng"(3) + null-short-desc(1) + raw UTF-8 text
    const utf8 = new TextEncoder().encode(value || "");
    frameBody = new Uint8Array(5 + utf8.length);
    frameBody[0] = 0x03; // UTF-8 encoding
    frameBody[1] = 0x65; frameBody[2] = 0x6e; frameBody[3] = 0x67; // "eng"
    frameBody[4] = 0x00; // empty short description
    frameBody.set(utf8, 5);
  } else {
    frameBody = body;
  }

  const frame = new Uint8Array(10 + frameBody.length);
  // Frame ID
  for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i);
  // Size (not synchsafe for v2.3)
  const size = frameBody.length;
  frame[4] = (size >> 24) & 0xff;
  frame[5] = (size >> 16) & 0xff;
  frame[6] = (size >> 8)  & 0xff;
  frame[7] = size & 0xff;
  // Flags = 0
  frame[8] = 0; frame[9] = 0;
  // Body
  frame.set(frameBody, 10);

  return frame;
};

/**
 * Wrap raw frame data (from previously parsed frame) into a full frame
 * with 10-byte header. Used for passthrough of cover art and other binary frames.
 */
ID3._wrapRawFrame = function(id, rawData) {
  const frame = new Uint8Array(10 + rawData.length);
  for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i);
  const size = rawData.length;
  frame[4] = (size >> 24) & 0xff;
  frame[5] = (size >> 16) & 0xff;
  frame[6] = (size >> 8)  & 0xff;
  frame[7] = size & 0xff;
  frame[8] = 0; frame[9] = 0;
  frame.set(rawData, 10);
  return frame;
};

/**
 * Build a USLT (lyrics) frame.
 * Format: encoding(1) + "eng"(3) + short_desc(1+null) + lyrics
 * Unlike COMM, USLT text area does not have its own encoding byte.
 */
ID3._makeLyricsFrame = function(id, text) {
  const utf8 = new TextEncoder().encode(text || "");
  // encoding(1) + language(3) + null desc(1) + utf8 lyrics
  const frameBody = new Uint8Array(5 + utf8.length);
  frameBody[0] = 0x03; // UTF-8
  frameBody[1] = 0x65; frameBody[2] = 0x6e; frameBody[3] = 0x67; // "eng"
  frameBody[4] = 0x00; // empty content descriptor
  frameBody.set(utf8, 5);

  const frame = new Uint8Array(10 + frameBody.length);
  for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i);
  const size = frameBody.length;
  frame[4] = (size >> 24) & 0xff;
  frame[5] = (size >> 16) & 0xff;
  frame[6] = (size >> 8)  & 0xff;
  frame[7] = size & 0xff;
  frame[8] = 0; frame[9] = 0;
  frame.set(frameBody, 10);
  return frame;
};

/**
 * Build an APIC (cover art) frame from raw image data.
 * Format: encoding(0x03=UTF8) + mimeType(null) + picType(0x03=cover) + desc(null) + imageBytes
 */
ID3._makeCoverFrame = function(id, mimeType, imageData) {
  const mimeBytes = new TextEncoder().encode(mimeType || "image/jpeg");
  const imgBytes = imageData instanceof Uint8Array ? imageData : new Uint8Array(imageData);
  const frameBody = new Uint8Array(1 + mimeBytes.length + 1 + 1 + 1 + imgBytes.length);
  let pos = 0;
  frameBody[pos++] = 0x03; // UTF-8 encoding byte
  frameBody.set(mimeBytes, pos); pos += mimeBytes.length;
  frameBody[pos++] = 0x00; // null terminator
  frameBody[pos++] = 0x03; // picture type: Cover (front)
  frameBody[pos++] = 0x00; // empty description (null)
  frameBody.set(imgBytes, pos);

  const frame = new Uint8Array(10 + frameBody.length);
  for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i);
  const size = frameBody.length;
  frame[4] = (size >> 24) & 0xff;
  frame[5] = (size >> 16) & 0xff;
  frame[6] = (size >> 8)  & 0xff;
  frame[7] = size & 0xff;
  frame[8] = 0; frame[9] = 0;
  frame.set(frameBody, 10);
  return frame;
};


// ═══════════════════════════════════════════════════════════════════════════
//  FLAC Vorbis Comment Reader / Writer (browser-side)
// ═══════════════════════════════════════════════════════════════════════════

const FLAC = {};

FLAC.read = function(buffer) {
  if (!buffer || buffer.byteLength < 8) return null;
  const data = new Uint8Array(buffer);
  if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== "fLaC") return null;

  FLAC._lastPicture = null; // Reset
  let offset = 4, lastBlock = false, blocks = [], vc = null, streamInfo = null;
  while (!lastBlock && offset + 4 <= data.length) {
    const h = data[offset], isLast = !!(h & 0x80), type = h & 0x7f;
    const sz = (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    const start = offset; offset += 4;
    if (sz <= 0 || offset + sz > data.length) break;
    blocks.push({ type, start, size: 4 + sz, lastBlock: isLast });
    if (type === 0 && sz >= 18) { // STREAMINFO — extract audio properties
      const raw = data.slice(offset, offset + sz);
      const sampleRate = (raw[10] << 12) | (raw[11] << 4) | (raw[12] >>> 4);
      const channels = ((raw[12] & 0x0E) >>> 1) + 1;
      const bitDepth = ((raw[12] & 0x01) << 4) | (raw[13] >>> 4) + 1;
      streamInfo = { sampleRate, channels, bitDepth };
    }
    if (type === 4) vc = FLAC._parseVC(data, offset, sz, blocks, start);
    if (type === 6) { // PICTURE block
      FLAC._parsePicture(data, offset, sz);
      blocks[blocks.length - 1]._isPicture = true;
    }
    offset += sz; lastBlock = isLast;
  }
  // CRITICAL: Preserve audio frame data that follows the last metadata block
  const audioData = offset < data.length ? data.slice(offset) : null;
  if (!vc) return { blocks, metadata: {}, cover: FLAC._lastPicture, isFLAC: true, audioData, streamInfo };
  const metadata = {};
  for (const f of vc.fields) {
    const eq = f.indexOf("="); if (eq < 0) continue;
    const k = f.slice(0, eq).toUpperCase(), v = f.slice(eq + 1);
    const map = { TITLE: "title", ARTIST: "artist", ALBUMARTIST: "albumArtist", ALBUM: "album",
      DATE: "year", YEAR: "year", TRACKNUMBER: "track", DISCNUMBER: "disc", GENRE: "genre",
      COMPOSER: "composer", COMMENT: "comment", LYRICS: "lyrics" };
    if (map[k]) metadata[map[k]] = v;
  }
  return { blocks, metadata, vorbisComment: vc, cover: FLAC._lastPicture, isFLAC: true, audioData, streamInfo };
};

FLAC._parseVC = function(data, offset, sz, blocks, blockStart) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = offset, vendorLen = v.getUint32(p, true); p += 4;
  const vendor = new TextDecoder("utf-8").decode(data.slice(p, p + vendorLen)); p += vendorLen;
  const count = v.getUint32(p, true); p += 4;
  const fields = [];
  for (let i = 0; i < count; i++) {
    const len = v.getUint32(p, true); p += 4;
    fields.push(new TextDecoder("utf-8", { fatal: true }).decode(data.slice(p, p + len))); p += len;
  }
  return { vendor, count, fields, blockIndex: blocks.length - 1, blockStart, blockSize: 4 + sz, rawStart: offset };
};

/** Parse FLAC PICTURE metadata block to extract cover art */
FLAC._parsePicture = function(data, offset, size) {
  try {
    let p = offset;
    const type = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; p += 4;
    const mimeLen = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; p += 4;
    const mime = new TextDecoder("utf-8").decode(data.slice(p, p + mimeLen)); p += mimeLen;
    const descLen = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; p += 4;
    p += descLen; // Skip description
    const width = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; p += 4;
    const height = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; p += 4;
    const depth = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; p += 4;
    const colors = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; p += 4;
    const picLen = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; p += 4;
    const picData = data.slice(p, p + picLen);
    FLAC._lastPicture = { mime: mime || "image/jpeg", data: picData, width, height };
  } catch (e) { FLAC._lastPicture = null; }
};

FLAC.write = function(buffer, tags, flacInfo) {
  if (!flacInfo || !flacInfo.vorbisComment) return buffer;
  const data = new Uint8Array(buffer), vc = flacInfo.vorbisComment, blocks = flacInfo.blocks;

  // Build new Vorbis Comment block
  const comments = [];
  const addC = (k, v) => { if (v) comments.push(k + "=" + v); };
  addC("TITLE", tags.title); addC("ARTIST", tags.artist); addC("ALBUMARTIST", tags.albumArtist);
  addC("ALBUM", tags.album); addC("DATE", tags.year); addC("TRACKNUMBER", tags.track);
  addC("DISCNUMBER", tags.disc); addC("GENRE", tags.genre); addC("COMPOSER", tags.composer);
  addC("COMMENT", tags.comment); addC("LYRICS", tags.lyrics);
  const managed = ["TITLE","ARTIST","ALBUMARTIST","ALBUM","DATE","YEAR","TRACKNUMBER","DISCNUMBER","GENRE","COMPOSER","COMMENT","LYRICS"];
  for (const f of vc.fields) if (!managed.includes(f.split("=")[0])) comments.push(f);
  const vendorBytes = new TextEncoder().encode(vc.vendor || "reference libFLAC 1.3.2 20170101");
  const cbs = comments.map(c => new TextEncoder().encode(c));
  let vcSz = 4 + vendorBytes.length + 4; for (const cb of cbs) vcSz += 4 + cb.length;
  const vcBlock = new Uint8Array(4 + vcSz), dvVC = new DataView(vcBlock.buffer);
  vcBlock[0] = 0x04; vcBlock[1] = (vcSz >> 16) & 0xff; vcBlock[2] = (vcSz >> 8) & 0xff; vcBlock[3] = vcSz & 0xff;
  let vp = 4; dvVC.setUint32(vp, vendorBytes.length, true); vp += 4;
  vcBlock.set(vendorBytes, vp); vp += vendorBytes.length;
  dvVC.setUint32(vp, comments.length, true); vp += 4;
  for (const cb of cbs) { dvVC.setUint32(vp, cb.length, true); vp += 4; vcBlock.set(cb, vp); vp += cb.length; }

  // Build PICTURE block if cover is provided
  let picBlock = null;
  const cov = tags._newCover;
  if (cov && cov.data && cov.data.length > 0) {
    const mimeB = new TextEncoder().encode(cov.mime || "image/jpeg");
    const imgD = cov.data instanceof Uint8Array ? cov.data : new Uint8Array(cov.data);
    const picSz = 4+4+mimeB.length+4+0+4+4+4+4+4+imgD.length;
    picBlock = new Uint8Array(4 + picSz);
    const dvP = new DataView(picBlock.buffer);
    picBlock[0] = 0x06; picBlock[1] = (picSz>>16)&0xff; picBlock[2] = (picSz>>8)&0xff; picBlock[3] = picSz&0xff;
    let pp = 4;
    dvP.setUint32(pp, 3, false); pp += 4;
    dvP.setUint32(pp, mimeB.length, false); pp += 4; picBlock.set(mimeB, pp); pp += mimeB.length;
    dvP.setUint32(pp, 0, false); pp += 4;
    dvP.setUint32(pp, 0, false); pp += 4;
    dvP.setUint32(pp, 0, false); pp += 4;
    dvP.setUint32(pp, 24, false); pp += 4;
    dvP.setUint32(pp, 0, false); pp += 4;
    dvP.setUint32(pp, imgD.length, false); pp += 4;
    picBlock.set(imgD, pp);
  }

  // Determine intent: keep existing cover, replace, or remove
  const keepCover = !tags._removeCover && !tags._newCover;

  // Assemble: replace old VC + PICTURE blocks with new ones
  const parts = [];
  let replaced = false;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const isVCBlock = (i === vc.blockIndex);
    const isPicBlock = (b.type === 6 || b._isPicture);

    if (isVCBlock) {
      // Replace old Vorbis Comment with new one
      if (!replaced) {
        parts.push(vcBlock);
        // Insert new PICTURE block right after VC
        if (picBlock) parts.push(picBlock);
        replaced = true;
      }
      continue; // Skip old VC block
    }

    if (isPicBlock) {
      if (keepCover && !replaced) {
        // Keep old PICTURE block as-is (no VC change yet — keepCover + VC at different index)
        parts.push(data.slice(b.start, b.start + b.size));
      } else if (keepCover && replaced) {
        // Already replaced VC, but keepCover → keep old picture
        parts.push(data.slice(b.start, b.start + b.size));
      }
      // else (_removeCover or _newCover): skip old PICTURE (it's already been replaced above)
      continue;
    }

    // Keep all other blocks
    parts.push(data.slice(b.start, b.start + b.size));
  }
  // If replaced is still false (shouldn't happen), add at end
  if (!replaced) {
    parts.push(vcBlock);
    if (picBlock) parts.push(picBlock);
  }

  // Reset all last-block flags, then set on the actual last block
  for (let p = 0; p < parts.length; p++) {
    parts[p][0] &= 0x7F; // Clear last-block bit
  }
  if (parts.length > 0) {
    parts[parts.length - 1][0] |= 0x80; // Set on last block
  }

  // Assemble final buffer — fLaC marker + metadata blocks + audio frames
  // CRITICAL: must include "fLaC" magic bytes, otherwise FLAC.read() fails
  // and the file is unplayable (media players require this marker)
  const fLaC = new Uint8Array([0x66, 0x4C, 0x61, 0x43]); // "fLaC"
  const total = 4 + parts.reduce((s, p) => s + p.length, 0) + (flacInfo.audioData ? flacInfo.audioData.length : 0);
  const result = new Uint8Array(total);
  let rp = 0;
  result.set(fLaC, rp); rp += 4;
  for (const p of parts) { result.set(p, rp); rp += p.length; }
  // Append audio frame data (CRITICAL: without this the FLAC file has no sound)
  if (flacInfo.audioData && flacInfo.audioData.length > 0) {
    result.set(flacInfo.audioData, rp);
  }
  return result.buffer;
};

// ═══════════════════════════════════════════════════════════════════════════
//  WAV (RIFF) Tag Reader / Writer (browser-side)
//  标签存放在 LIST/INFO 子块（INAM/IART/IPRD/ICRD/IGNR/ITRK/ICMT）
// ═══════════════════════════════════════════════════════════════════════════

const WAV = {};

const WAV_INFO_MAP = {
  INAM: "title", IART: "artist", IPRD: "album", ICRD: "year",
  IGNR: "genre", ITRK: "track", IPRT: "track", ICMT: "comment",
  ICOP: "copyright", ISFT: "encoder", ILYR: "lyrics", // ILYR 为非标准但广泛支持（foobar2000/千千静听）
};

WAV.read = function(buffer) {
  if (!buffer || buffer.byteLength < 12) return null;
  const data = new Uint8Array(buffer);
  const rd32 = (o) => (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 0;
  // "RIFF" ... "WAVE"
  if (data[0] !== 0x52 || data[1] !== 0x49 || data[2] !== 0x46 || data[3] !== 0x46) return null;
  if (data[8] !== 0x57 || data[9] !== 0x41 || data[10] !== 0x56 || data[11] !== 0x45) return null;

  const metadata = {};
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
    const size = rd32(offset + 4);
    if (size < 0 || offset + 8 + size > data.length) break; // 截断保护
    const body = offset + 8;
    chunks.push({ id, offset, size, body });
    if (id === "LIST" && data[body] === 0x49 && data[body + 1] === 0x4E &&
        data[body + 2] === 0x46 && data[body + 3] === 0x4F) {
      let p = body + 4;
      const end = body + size;
      while (p + 8 <= end) {
        const sid = String.fromCharCode(data[p], data[p + 1], data[p + 2], data[p + 3]);
        const ssz = rd32(p + 4);
        if (p + 8 + ssz > end) break;
        const text = new TextDecoder("utf-8").decode(data.slice(p + 8, p + 8 + ssz)).replace(/\0+$/, "");
        const key = WAV_INFO_MAP[sid];
        if (key && !metadata[key]) metadata[key] = text;
        p += 8 + ssz + (ssz & 1); // RIFF chunk 需 2 字节对齐
      }
    }
    offset = body + size + (size & 1);
  }
  for (const k of ["title","artist","album","albumArtist","composer","year","track","disc","genre","comment","lyrics"]) {
    if (metadata[k] === undefined) metadata[k] = "";
  }
  return { isWAV: true, metadata, chunks, audioInfo: null };
};

WAV.write = function(buffer, tags, wavInfo) {
  const data = new Uint8Array(buffer);
  const s = (t) => { const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i); return b; };
  const u32 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let q = 0; for (const x of a) { o.set(x, q); q += x.length; } return o; };

  // 1. 构建新 LIST/INFO 块
  const rev = { title: "INAM", artist: "IART", album: "IPRD", year: "ICRD",
                genre: "IGNR", track: "ITRK", comment: "ICMT", lyrics: "ILYR" };
  const subs = [];
  for (const key of Object.keys(rev)) {
    const val = tags[key];
    if (!val) continue;
    const txt = new TextEncoder().encode(String(val) + "\0");
    const pad = (txt.length & 1) ? new Uint8Array([0]) : new Uint8Array(0);
    subs.push(cat(s(rev[key]), u32(txt.length), txt, pad));
  }
  let newInfo = null;
  if (subs.length) {
    const inner = cat(s("INFO"), ...subs);
    newInfo = cat(s("LIST"), u32(inner.length), inner);
    // LIST 自身 size 为奇数时补 1 字节对齐
    if (inner.length & 1) newInfo = cat(newInfo, new Uint8Array([0]));
  }

  // 2. 保留所有非 LIST-INFO 的原始 chunk（原样拷贝，含 pad）
  const keep = [];
  if (wavInfo && wavInfo.chunks) {
    for (const c of wavInfo.chunks) {
      if (c.id === "LIST" && data[c.body] === 0x49 && data[c.body + 1] === 0x4E &&
          data[c.body + 2] === 0x46 && data[c.body + 3] === 0x4F) continue; // 丢弃旧 INFO
      const total = 8 + c.size + (c.size & 1);
      keep.push(data.slice(c.offset, c.offset + total));
    }
  }

  // 3. 重组：WAVE + 新INFO + 原chunks（音频数据原样保留）
  const parts = [s("WAVE")];
  if (newInfo) parts.push(newInfo);
  for (const k of keep) parts.push(k);
  const body = cat(...parts);
  return cat(s("RIFF"), u32(body.length), body).buffer;
};

// ═══════════════════════════════════════════════════════════════════════════
//  M4A / MP4 Tag Reader / Writer (browser-side)
//  标签存放在 moov/udta/meta/ilst 下的 ©nam/©ART/©alb/©day/©gen/aART/©lyr 等
//  每个 item 内含一个 data box（ver/flags=1 表示 UTF-8 文本）
// ═══════════════════════════════════════════════════════════════════════════

const M4A = {};

const M4A_TAG_MAP = {
  "\u00a9nam": "title", "\u00a9ART": "artist", "\u00a9alb": "album",
  "\u00a9day": "year", "\u00a9gen": "genre", "\u00a9wrt": "composer",
  "\u00a9cmt": "comment", "aART": "albumArtist", "\u00a9lyr": "lyrics",
  "\u00a9too": "encoder",
};

M4A._boxType = function(data, o) {
  return String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
};
M4A._boxSize = function(data, o) {
  return ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
};

M4A.read = function(buffer) {
  if (!buffer || buffer.byteLength < 12) return null;
  const data = new Uint8Array(buffer);
  if (M4A._boxType(data, 4) !== "ftyp") return null; // MP4 必须以 ftyp 开头

  const metadata = {};
  const result = { isM4A: true, metadata, ilstOffset: 0, ilstSize: 0, ancestors: [] };

  // 递归扫描容器 box，定位 ilst 并记录祖先链（用于写入时回填 size）
  const walk = (start, end, ancestors) => {
    let off = start;
    while (off + 8 <= end) {
      const size = M4A._boxSize(data, off);
      const t = M4A._boxType(data, off + 4);
      if (size < 8 || off + size > end) break;
      if (t === "moov" || t === "udta" || t === "meta" || t === "ilst") {
        const chain = ancestors.concat([{ offset: off, size }]);
        if (t === "ilst") {
          result.ilstOffset = off;
          result.ilstSize = size;
          result.ancestors = chain;
          // 解析 ilst 内的 item
          let p = off + 8;
          const iend = off + size;
          while (p + 8 <= iend) {
            const isz = M4A._boxSize(data, p);
            const it = M4A._boxType(data, p + 4);
            if (isz < 8 || p + isz > iend) break;
            const key = M4A_TAG_MAP[it];
            if (key) {
              // item 内含 data box：header(8) + ver/flags(4) + type(4) + locale(4) + value
              const dOff = p + 8;
              if (M4A._boxType(data, dOff + 4) === "data") {
                const dSize = M4A._boxSize(data, dOff);
                // data box: size(4)+'data'(4)+version(1)+flags(3=wellKnown)+locale(4)+value
                const wellKnown = (data[dOff + 9] << 16) | (data[dOff + 10] << 8) | data[dOff + 11];
                if (dSize >= 16 && wellKnown === 1) { // 1 = UTF-8 text
                  const txt = new TextDecoder("utf-8")
                    .decode(data.slice(dOff + 16, dOff + dSize)).replace(/\0+$/, "");
                  if (txt && !metadata[key]) metadata[key] = txt;
                }
              }
            }
            p += isz;
          }
        } else {
          // meta 有 4 字节 version/flags 前缀；moov/udta 直接是子 box
          walk(t === "meta" ? off + 12 : off + 8, off + size, chain);
        }
      }
      off += size;
    }
  };
  walk(0, data.length, []);

  // 没有 ilst 也不算有效 M4A（元数据区不存在）
  if (result.ilstOffset === 0) return null;
  for (const k of ["title","artist","album","albumArtist","composer","year","track","disc","genre","comment","lyrics"]) {
    if (metadata[k] === undefined) metadata[k] = "";
  }
  return result;
};

M4A.write = function(buffer, tags, m4aInfo) {
  const data = new Uint8Array(buffer);
  const s = (t) => { const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i); return b; };
  const u32 = (v) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let q = 0; for (const x of a) { o.set(x, q); q += x.length; } return o; };

  // 1. 构建新 ilst
  const rev = { title: "\u00a9nam", artist: "\u00a9ART", album: "\u00a9alb", year: "\u00a9day",
                genre: "\u00a9gen", composer: "\u00a9wrt", comment: "\u00a9cmt",
                albumArtist: "aART", lyrics: "\u00a9lyr" };
  const items = [];
  for (const key of Object.keys(rev)) {
    const val = tags[key];
    if (!val) continue;
    const txt = new TextEncoder().encode(String(val));
    // data box: size + "data" + version(1)+flags(3=wellKnown=1 UTF8) + locale(4) + value
    const dataBox = cat(u32(16 + txt.length), s("data"), new Uint8Array([0, 0, 0, 1]), new Uint8Array(4), txt);
    items.push(cat(u32(8 + dataBox.length), s(rev[key]), dataBox));
  }
  const inner = cat(...items);
  const newIlst = cat(u32(8 + inner.length), s("ilst"), inner);

  // 2. 原文件没有 ilst → 无法安全插入（需重建 moov），直接返回原 buffer
  if (!m4aInfo || m4aInfo.ilstOffset === 0) return buffer;
  const oldOff = m4aInfo.ilstOffset, oldSize = m4aInfo.ilstSize;
  const delta = newIlst.length - oldSize;

  // 3. 替换 ilst（ilst 之前的字节不变，祖先 offset 均不受影响）
  let out = cat(data.slice(0, oldOff), newIlst, data.slice(oldOff + oldSize));

  // 4. 回填祖先 box 的 size（从内到外累加 delta）。
  //    注意跳过 ilst 自身：它的新 size 在构建时已写对，再 +delta 会错。
  for (let i = m4aInfo.ancestors.length - 1; i >= 0; i--) {
    const a = m4aInfo.ancestors[i];
    if (a.offset === oldOff) continue;
    const cur = ((out[a.offset] << 24) | (out[a.offset + 1] << 16) | (out[a.offset + 2] << 8) | out[a.offset + 3]) >>> 0;
    const nv = (cur + delta) >>> 0;
    out[a.offset] = (nv >>> 24) & 255; out[a.offset + 1] = (nv >>> 16) & 255;
    out[a.offset + 2] = (nv >>> 8) & 255; out[a.offset + 3] = nv & 255;
  }
  return out.buffer;
};

// ═══════════════════════════════════════════════════════════════════════════
//  OGG Vorbis Tag Reader / Writer (browser-side)
//  标签在 comment header packet（packet_type=0x03 + "vorbis" + vendor + comments）
//  写入时重建该 page（含 CRC32），音频 page 原样保留并重排 sequence
// ═══════════════════════════════════════════════════════════════════════════

const OGG = {};

// OGG CRC-32（poly 0x04c11db7，非反射）
OGG._crcTable = (function () {
  const t = [];
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    t.push(r >>> 0);
  }
  return t;
})();
OGG._crc32 = function (bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (((crc << 8) & 0xffffffff) ^ OGG._crcTable[((crc >>> 24) & 0xff) ^ bytes[i]]) >>> 0;
  }
  return crc >>> 0;
};

const OGG_TAG_MAP = {
  TITLE: "title", ARTIST: "artist", ALBUM: "album", ALBUMARTIST: "albumArtist",
  DATE: "year", YEAR: "year", TRACKNUMBER: "track", DISCNUMBER: "disc",
  GENRE: "genre", COMPOSER: "composer", COMMENT: "comment", LYRICS: "lyrics",
};

OGG.read = function (buffer) {
  if (!buffer || buffer.byteLength < 27) return null;
  const data = new Uint8Array(buffer);
  if (data[0] !== 0x4F || data[1] !== 0x67 || data[2] !== 0x67 || data[3] !== 0x53) return null; // "OggS"
  const rd32 = (o) => (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 0;

  // 1. 遍历所有 page
  const pages = [];
  let off = 0;
  while (off + 27 <= data.length) {
    if (data[off] !== 0x4F || data[off + 1] !== 0x67 || data[off + 2] !== 0x67 || data[off + 3] !== 0x53) break;
    const type = data[off + 5];
    const serial = rd32(off + 14);
    const nseg = data[off + 26];
    const hdrLen = 27 + nseg;
    if (off + hdrLen > data.length) break;
    let pktLen = 0;
    for (let i = 0; i < nseg; i++) pktLen += data[off + 27 + i];
    const bodyStart = off + hdrLen;
    if (bodyStart + pktLen > data.length) break;
    pages.push({ off, type, serial, nseg, segStart: off + 27, bodyStart, pktLen, total: hdrLen + pktLen });
    off = bodyStart + pktLen;
  }
  if (!pages.length) return null;

  // 2. 找 comment header packet（0x03 + "vorbis"）
  let commentPacket = null;
  for (const pg of pages) {
    let p = pg.bodyStart;
    let cur = [];
    for (let s = 0; s < pg.nseg; s++) {
      const seg = data[pg.segStart + s];
      for (let k = 0; k < seg; k++) cur.push(data[p + k]);
      p += seg;
      if (seg < 255) { // packet 结束
        const pk = Uint8Array.from(cur);
        if (pk.length >= 7 && pk[0] === 0x03 &&
            pk[1] === 0x76 && pk[2] === 0x6F && pk[3] === 0x72 && pk[4] === 0x62 && pk[5] === 0x69 && pk[6] === 0x73) {
          commentPacket = pk;
          break;
        }
        cur = [];
      }
    }
    if (commentPacket) break;
  }
  if (!commentPacket) return null;

  // 3. 解析 vendor + comments
  const dv = new DataView(commentPacket.buffer, commentPacket.byteOffset, commentPacket.byteLength);
  let p = 7;
  if (p + 4 > commentPacket.length) return null;
  const vlen = dv.getUint32(p, true); p += 4;
  if (p + vlen + 4 > commentPacket.length) return null;
  const vendor = new TextDecoder("utf-8").decode(commentPacket.slice(p, p + vlen)); p += vlen;
  const count = dv.getUint32(p, true); p += 4;
  const fields = [];
  for (let i = 0; i < count; i++) {
    if (p + 4 > commentPacket.length) break;
    const len = dv.getUint32(p, true); p += 4;
    if (p + len > commentPacket.length) break;
    fields.push(new TextDecoder("utf-8").decode(commentPacket.slice(p, p + len))); p += len;
  }

  const metadata = {};
  for (const f of fields) {
    const eq = f.indexOf("="); if (eq < 0) continue;
    const k = f.slice(0, eq).toUpperCase(), v = f.slice(eq + 1);
    if (OGG_TAG_MAP[k] && !metadata[OGG_TAG_MAP[k]]) metadata[OGG_TAG_MAP[k]] = v;
  }
  for (const k of ["title","artist","album","albumArtist","composer","year","track","disc","genre","comment","lyrics"]) {
    if (metadata[k] === undefined) metadata[k] = "";
  }
  for (const k of ["title","artist","album","albumArtist","composer","year","track","disc","genre","comment","lyrics"]) {
    if (metadata[k] === undefined) metadata[k] = "";
  }
  return { isOGG: true, metadata, vendor, fields, serial: pages[0].serial, pages, tailOffset: off };
};

OGG.write = function (buffer, tags, oggInfo) {
  const data = new Uint8Array(buffer);
  const s = (t) => { const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i); return b; };
  const u32 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let q = 0; for (const x of a) { o.set(x, q); q += x.length; } return o; };

  // 1. 构建新 comment packet
  const addC = (k, v) => { if (v) comments.push(k + "=" + v); };
  const comments = [];
  addC("TITLE", tags.title); addC("ARTIST", tags.artist); addC("ALBUMARTIST", tags.albumArtist);
  addC("ALBUM", tags.album); addC("DATE", tags.year); addC("TRACKNUMBER", tags.track);
  addC("DISCNUMBER", tags.disc); addC("GENRE", tags.genre); addC("COMPOSER", tags.composer);
  addC("COMMENT", tags.comment); addC("LYRICS", tags.lyrics);
  const managed = ["TITLE", "ARTIST", "ALBUMARTIST", "ALBUM", "DATE", "YEAR", "TRACKNUMBER",
    "DISCNUMBER", "GENRE", "COMPOSER", "COMMENT", "LYRICS"];
  for (const f of (oggInfo.fields || [])) if (!managed.includes(f.split("=")[0])) comments.push(f);

  const vb = new TextEncoder().encode(oggInfo.vendor || "music-tag-cf");
  const cbs = comments.map(c => new TextEncoder().encode(c));
  const pkt = new Uint8Array(7 + 4 + vb.length + 4 + cbs.reduce((n, b) => n + 4 + b.length, 0) + 1);
  pkt[0] = 0x03; pkt.set(s("vorbis"), 1);
  let p = 7;
  pkt.set(u32(vb.length), p); p += 4; pkt.set(vb, p); p += vb.length;
  pkt.set(u32(cbs.length), p); p += 4;
  for (const b of cbs) { pkt.set(u32(b.length), p); p += 4; pkt.set(b, p); p += b.length; }
  pkt[p] = 0x01; // framing bit

  // 2. 分页（单 page body 上限 255*254，留一个终止 segment）
  const MAX_BODY = 255 * 254;
  const mkPage = (seq, type, body) => {
    const segs = [];
    let left = body.length;
    while (left >= 255) { segs.push(255); left -= 255; }
    segs.push(left);
    const hdr = new Uint8Array(27 + segs.length);
    hdr.set(s("OggS"), 0);
    hdr[4] = 0;            // version
    hdr[5] = type;         // header type
    hdr.set(u32(0), 6); hdr.set(u32(0), 10); // granule = 0（header page）
    hdr.set(u32(oggInfo.serial), 14);
    hdr.set(u32(seq), 18);
    hdr.set([0, 0, 0, 0], 22); // CRC 占位
    hdr[26] = segs.length;
    hdr.set(segs, 27);
    const page = cat(hdr, body);
    const crc = OGG._crc32(page);
    page[22] = (crc >>> 24) & 255; page[23] = (crc >>> 16) & 255;
    page[24] = (crc >>> 8) & 255; page[25] = crc & 255;
    return page;
  };
  const newCommentPages = [];
  let rem = pkt, seqCounter = 0;
  while (rem.length > 0) {
    const take = rem.slice(0, MAX_BODY);
    rem = rem.slice(MAX_BODY);
    newCommentPages.push(mkPage(seqCounter++, 0x00, take));
  }

  // 3. 重组：保留原 page 顺序，仅替换 comment 所在 page，音频 page 原样拷贝并重排 seq
  const parts = [];
  let outSeq = 0;
  let replaced = false;
  for (const pg of oggInfo.pages) {
    if (!replaced && pg.bodyStart <= (pg.off + pg.total)) {
      // 判断该 page 是否含 comment header packet
      let hasComment = false;
      let q = pg.bodyStart, cur = [];
      for (let sN = 0; sN < pg.nseg; sN++) {
        const seg = data[pg.segStart + sN];
        cur = cur.concat(Array.from(data.slice(q, q + seg))); q += seg;
        if (seg < 255) {
          if (cur.length >= 7 && cur[0] === 0x03 &&
              cur[1] === 0x76 && cur[2] === 0x6F && cur[3] === 0x72 && cur[4] === 0x62 && cur[5] === 0x69 && cur[6] === 0x73) {
            hasComment = true; break;
          }
          cur = [];
        }
      }
      if (hasComment) {
        for (const np of newCommentPages) { parts.push(np); outSeq++; }
        replaced = true;
        continue;
      }
    }
    // 原样拷贝该 page，仅重写 sequence number（保持音频 granule/数据不变）
    const raw = data.slice(pg.off, pg.off + pg.total).slice();
    raw[18] = outSeq & 255; raw[19] = (outSeq >>> 8) & 255;
    raw[20] = (outSeq >>> 16) & 255; raw[21] = (outSeq >>> 24) & 255;
    parts.push(raw);
    outSeq++;
  }
  // 保留 pages 之后的尾部原始数据（防御非标准尾部字节被丢弃）
  if (oggInfo.tailOffset && oggInfo.tailOffset < data.length) {
    parts.push(data.slice(oggInfo.tailOffset));
  }
  return cat(...parts).buffer;
};

/** Parse MP3/MPEG audio info: scan for first sync frame, extract bitrate + sample rate */
ID3._parseMP3Info = function(buffer) {
  try {
    const data = new Uint8Array(buffer);
    // Skip ID3v2 tag header if present
    let start = 0;
    if (data.length > 9 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
      start = 10 + ((data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]);
    }
    // MPEG1 Layer3 bitrate table (kbps) indexed by [versionIdx][layerIdx][bitrateIdx]
    const brTable = [
      // MPEG1
      [[0,32,64,96,128,160,192,224,256,288,320,352,384,416,448,0],
       [0,32,48,56, 64, 80, 96,112,128,160,192,224,256,320,384,0],
       [0,32,40,48, 56, 64, 80, 96,112,128,160,192,224,256,320,0]],
      // MPEG2/2.5
      [[0,32,48,56,64,80,96,112,128,144,160,176,192,224,256,0],
       [0, 8,16,24,32,40,48, 56, 64, 80, 96,112,128,144,160,0],
       [0, 8,16,24,32,40,48, 56, 64, 80, 96,112,128,144,160,0]]
    ];
    const srTable = [[44100,48000,32000],[22050,24000,16000],[11025,12000,8000]];
    const skip = Math.min(data.length, start + 32 * 1024);
    for (let i = start; i < skip - 1; i++) {
      if (data[i] !== 0xFF || (data[i+1] & 0xE0) !== 0xE0) continue;
      const b = data[i+1];
      const verIdx = (b & 0x18) === 0x18 ? 0 : (b & 0x08) ? 1 : 2;
      const layerIdx = 3 - ((b & 0x06) >>> 1);
      if (layerIdx < 0 || layerIdx > 2) continue;
      const brIdx = (data[i+2] & 0xF0) >>> 4;
      if (brIdx === 0 || brIdx === 15) continue;
      const srIdx = (data[i+2] & 0x0C) >>> 2;
      if (srIdx === 3) continue;
      const bitrate = brTable[verIdx === 0 ? 0 : 1][layerIdx][brIdx];
      const sampleRate = srTable[verIdx][srIdx];
      const channels = (b & 0x06) === 0x06 ? 1 : 2;
      if (bitrate > 0) return { bitrate, sampleRate, channels };
    }
  } catch(e) {}
  return null;
};



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
    for (const raw of String(text).split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const re = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
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
