/**
 * 新增三格式（M4A / OGG / WAV）读写回归测试
 * 覆盖：读取、写入、改、删（清空字段）、二次写入不损坏、音频数据保留、中文乱码
 * 运行：node test_formats.cjs
 */
const fs = require("fs");
const path = process.argv[2] || "F:/WorkSpace/Workbuddy/Github项目分析部署/music-tag-cf/src/template.html";
const html = fs.readFileSync(path, "utf8");
const s = html.indexOf("const ID3 = {};"), e = html.indexOf("  Application State & Logic");
if (s < 0 || e < 0) { console.error("抽取失败"); process.exit(1); }
let code = html.slice(s, e);
code = code.slice(0, code.lastIndexOf("// ═"));
const { ID3, FLAC, M4A, OGG, WAV } = new Function(code + "\n return {ID3, FLAC, M4A, OGG, WAV};")();

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ✅ ${n}${extra ? " → " + extra : ""}`); }
  else { fail++; console.log(`  ❌ ${n}${extra ? " → " + extra : ""}`); }
};

const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let q = 0; for (const x of a) { o.set(x, q); q += x.length; } return o; };
const str = t => { const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i); return b; };
const u32be = v => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const u32le = v => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);

// ── OGG CRC32 ──
const crcTable = (() => { const t = []; for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1); t.push(r >>> 0); } return t; })();
const crc32 = b => { let c = 0; for (const x of b) c = (((c << 8) & 0xffffffff) ^ crcTable[((c >>> 24) & 0xff) ^ x]) >>> 0; return c >>> 0; };
const segOf = p => { const s = []; let l = p.length; while (l >= 255) { s.push(255); l -= 255; } s.push(l); return s; };

function buildOGG(fields, audioLen = 400) {
  const serial = 0x1A2B3C4D;
  const idh = cat(new Uint8Array([0x01]), str("vorbis"), u32le(0), new Uint8Array([2]), u32le(44100),
    u32le(0), u32le(160000), u32le(0), new Uint8Array([0xb8]), new Uint8Array([1]));
  const vb = str("music-tag-cf");
  const cbs = Object.entries(fields).filter(([, v]) => v)
    .map(([k, v]) => new TextEncoder().encode(`${k}=${v}`)); // 必须 UTF-8
  const ch = new Uint8Array(7 + 4 + vb.length + 4 + cbs.reduce((n, b) => n + 4 + b.length, 0) + 1);
  ch[0] = 0x03; ch.set(str("vorbis"), 1);
  let p = 7;
  ch.set(u32le(vb.length), p); p += 4; ch.set(vb, p); p += vb.length;
  ch.set(u32le(cbs.length), p); p += 4;
  for (const b of cbs) { ch.set(u32le(b.length), p); p += 4; ch.set(b, p); p += b.length; }
  ch[p] = 0x01;

  const mkPage = (type, granule, seq, packet) => {
    const seg = segOf(packet);
    const hdr = cat(str("OggS"), new Uint8Array([0, type]), new Uint8Array(8), u32le(serial), u32le(seq),
      new Uint8Array([0, 0, 0, 0]), new Uint8Array([seg.length]), new Uint8Array(seg));
    // granule (8 bytes LE) 写在第 6..13
    for (let i = 0; i < 8; i++) hdr[6 + i] = Math.floor(granule / Math.pow(256, i)) % 256;
    const page = cat(hdr, packet);
    const crc = crc32(page);
    page[22] = (crc >>> 24) & 255; page[23] = (crc >>> 16) & 255; page[24] = (crc >>> 8) & 255; page[25] = crc & 255;
    return page;
  };
  const audio = new Uint8Array(audioLen).fill(0x5A);
  // 音频也必须封装成合法 page（否则 OGG.read 只解析到 header pages，尾部数据会丢）
  return cat(mkPage(0x02, 0, 0, idh), mkPage(0x00, 0, 1, ch),
    mkPage(0x04, 8000, 2, cat(new Uint8Array([0x05]), str("vorbis"), new Uint8Array(20).fill(0x11))),
    mkPage(0x00, 16000, 3, audio));
}

function buildWAV(fields, audioLen = 300) {
  const chunks = [str("fmt "), u32le(16), new Uint8Array([1, 0]), new Uint8Array([2, 0]), u32le(44100), u32le(16000), new Uint8Array([4, 0]), new Uint8Array([16, 0])];
  const map = { INAM: "title", IART: "artist", IPRD: "album", ICRD: "year", IGNR: "genre", ITRK: "track", ICMT: "comment" };
  const items = [];
  for (const [ck, key] of Object.entries(map)) {
    if (!fields[key]) continue;
    const v = new TextEncoder().encode(fields[key] + "\0"); // 必须 UTF-8
    items.push(str(ck), u32le(v.length), v);
    if (v.length & 1) items.push(new Uint8Array([0]));
  }
  if (items.length) { const ib = cat(str("INFO"), ...items); chunks.push(str("LIST"), u32le(ib.length), ib); }
  const data = new Uint8Array(audioLen).fill(0);
  chunks.push(str("data"), u32le(data.length), data);
  const body = cat(str("WAVE"), ...chunks);
  return cat(str("RIFF"), u32le(body.length), body);
}

function box(type, ...payload) { const inner = cat(str(type), ...payload); return cat(u32be(inner.length + 4), inner); }
function buildM4A(fields, audioLen = 200) {
  const items = [];
  const put = (name, val) => {
    const txt = new TextEncoder().encode(val); // 必须是 UTF-8，不能用 str()（Latin-1）
    // data box: size + "data" + ver(1)+flags(3=wellKnown 1=UTF8) + locale(4) + value
    items.push(box(name, box("data", new Uint8Array([0, 0, 0, 1]), new Uint8Array(4), txt)));
  };
  if (fields.title) put("\u00a9nam", fields.title);
  if (fields.artist) put("\u00a9ART", fields.artist);
  if (fields.album) put("\u00a9alb", fields.album);
  if (fields.year) put("\u00a9day", fields.year);
  const ilst = box("ilst", ...items);
  const meta = box("meta", new Uint8Array(4), box("hdlr", u32be(0), str("mdirappl"), u32be(0), u32be(0), u32be(0), str("\0")), ilst);
  const moov = box("moov", box("udta", meta));
  const ftyp = box("ftyp", str("M4A "), u32be(0), str("M4A mp42isom"));
  const mdat = box("mdat", new Uint8Array(audioLen).fill(0x33));
  return cat(ftyp, moov, mdat);
}

const lrc = "[00:12.570]难以忘记初次见你\n[00:16.860]一双迷人的眼睛";

console.log("\n══════ M4A ══════");
{
  const buf = buildM4A({ title: "原标题", artist: "原艺术家", album: "原专辑", year: "2003" });
  const info = M4A.read(buf);
  ok("M4A 识别", info && info.isM4A);
  ok("读 title", info.metadata.title === "原标题", info.metadata.title);
  ok("读 artist", info.metadata.artist === "原艺术家");
  ok("读 year", info.metadata.year === "2003");

  // 写：改标题 + 加歌词
  const tags = { title: "七里香", artist: "周杰伦", album: "七里香", year: "2004", lyrics: lrc };
  const buf2 = M4A.write(buf, tags, info);
  const info2 = M4A.read(buf2);
  ok("改写 title", info2.metadata.title === "七里香", info2.metadata.title);
  ok("改写 artist", info2.metadata.artist === "周杰伦");
  ok("写入歌词", info2.metadata.lyrics && info2.metadata.lyrics.includes("难以忘记初次见你"),
    JSON.stringify((info2.metadata.lyrics || "").slice(0, 20)));
  ok("音频数据保留(mdat)", buf2.byteLength >= 200 && new Uint8Array(buf2.slice(buf2.byteLength - 200)).every(b => b === 0x33));
  ok("box size 自洽(可重复读取)", M4A.read(M4A.write(buf2, tags, info2)).metadata.title === "七里香");

  // 二次写
  const buf3 = M4A.write(buf2, { title: "夜曲", lyrics: lrc }, info2);
  const info3 = M4A.read(buf3);
  ok("二次写入 title", info3.metadata.title === "夜曲", info3.metadata.title);
  ok("二次写入歌词仍在", (info3.metadata.lyrics || "").includes("迷人的眼睛"));

  // 删：清空所有字段
  const buf4 = M4A.write(buf, {}, info);
  const info4 = M4A.read(buf4);
  ok("清空字段后 title 为空", info4.metadata.title === "", JSON.stringify(info4.metadata.title));
}

console.log("\n══════ OGG ══════");
{
  const buf = buildOGG({ TITLE: "原标题", ARTIST: "原艺术家", ALBUM: "原专辑", DATE: "2003" });
  const info = OGG.read(buf);
  ok("OGG 识别", info && info.isOGG);
  ok("读 title", info.metadata.title === "原标题", info.metadata.title);
  ok("读 artist", info.metadata.artist === "原艺术家");
  ok("读 year(DATE)", info.metadata.year === "2003");

  const tags = { title: "七里香", artist: "周杰伦", album: "七里香", year: "2004", lyrics: lrc };
  const buf2 = OGG.write(buf, tags, info);
  const info2 = OGG.read(buf2);
  ok("改写 title", info2.metadata.title === "七里香", info2.metadata.title);
  ok("写入歌词", info2.metadata.lyrics && info2.metadata.lyrics.includes("难以忘记初次见你"),
    JSON.stringify((info2.metadata.lyrics || "").slice(0, 20)));
  ok("写入后仍可被解析(CRC正确)", info2 && info2.isOGG);

  // 校验每页 CRC
  const u8 = new Uint8Array(buf2);
  let crcOk = true, off = 0, pageCount = 0;
  while (off + 27 <= u8.length) {
    if (u8[off] !== 0x4F || u8[off+1] !== 0x67 || u8[off+2] !== 0x67 || u8[off+3] !== 0x53) break;
    const nseg = u8[off + 26];
    let pktLen = 0; for (let i = 0; i < nseg; i++) pktLen += u8[off + 27 + i];
    const total = 27 + nseg + pktLen;
    const stored = ((u8[off+22] << 24) | (u8[off+23] << 16) | (u8[off+24] << 8) | u8[off+25]) >>> 0;
    const copy = u8.slice(off, off + total).slice();
    copy[22] = 0; copy[23] = 0; copy[24] = 0; copy[25] = 0;
    if (crc32(copy) !== stored) { crcOk = false; break; }
    pageCount++; off += total;
  }
  ok(`全部 ${pageCount} 页 CRC32 正确`, crcOk);

  // 音频数据保留
  ok("音频 page 数据保留", u8.length >= 400 && u8[u8.length - 400] === 0x5A && u8[u8.length - 1] === 0x5A);

  // 二次写
  const buf3 = OGG.write(buf2, { title: "夜曲", lyrics: lrc }, info2);
  const info3 = OGG.read(buf3);
  ok("二次写入 title", info3.metadata.title === "夜曲", info3.metadata.title);
  ok("二次写入歌词仍在", (info3.metadata.lyrics || "").includes("迷人的眼睛"));

  // 未管理字段保留
  const bufC = buildOGG({ TITLE: "T", ARTIST: "A", CUSTOMFIELD: "自定义值" });
  const infoC = OGG.read(bufC);
  const bufC2 = OGG.write(bufC, { title: "T2" }, infoC);
  const infoC2 = OGG.read(bufC2);
  ok("OGG 未管理字段保留", (infoC2.fields || []).some(f => f === "CUSTOMFIELD=自定义值"),
    JSON.stringify(infoC2.fields));
}

console.log("\n══════ WAV ══════");
{
  const buf = buildWAV({ title: "原标题", artist: "原艺术家", album: "原专辑", year: "2003", genre: "Pop" });
  const info = WAV.read(buf);
  ok("WAV 识别", info && info.isWAV);
  ok("读 title", info.metadata.title === "原标题", info.metadata.title);
  ok("读 artist", info.metadata.artist === "原艺术家");
  ok("读 year", info.metadata.year === "2003");
  ok("读 genre", info.metadata.genre === "Pop");
  ok("fmt/data chunk 均保留", (info.chunks || []).map(c => c.id.trim()).includes("fmt")
    && (info.chunks || []).map(c => c.id.trim()).includes("data"),
    JSON.stringify((info.chunks || []).map(c => c.id)));

  const tags = { title: "七里香", artist: "周杰伦", album: "七里香", year: "2004", genre: "Mandarin Pop", comment: "备注" };
  const buf2 = WAV.write(buf, tags, info);
  const info2 = WAV.read(buf2);
  ok("改写 title", info2.metadata.title === "七里香", info2.metadata.title);
  ok("改写 artist", info2.metadata.artist === "周杰伦");
  ok("改写 genre", info2.metadata.genre === "Mandarin Pop");
  ok("写入 comment", info2.metadata.comment === "备注");

  // RIFF size 自洽（RIFF 头部 size 是 little-endian）
  const u8 = new Uint8Array(buf2);
  const riffSize = (u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24)) >>> 0;
  ok("RIFF size 正确(等于文件长-8)", riffSize === u8.length - 8, `${riffSize} vs ${u8.length - 8}`);
  ok("data chunk 保留", (info2.chunks || []).some(c => c.id.trim() === "data"));
  ok("fmt chunk 保留", (info2.chunks || []).some(c => c.id.trim() === "fmt"),
    JSON.stringify((info2.chunks || []).map(c => c.id)));

  // 音频数据保留
  ok("音频样本保留", u8.length >= 300 && u8[u8.length - 300] === 0 && u8[u8.length - 1] === 0);

  // 二次写
  const buf3 = WAV.write(buf2, { title: "夜曲" }, info2);
  const info3 = WAV.read(buf3);
  ok("二次写入 title", info3.metadata.title === "夜曲", info3.metadata.title);

  // 删：清空
  const buf4 = WAV.write(buf, {}, info);
  const info4 = WAV.read(buf4);
  ok("清空字段后 title 为空", info4.metadata.title === "", JSON.stringify(info4.metadata.title));
  ok("清空后仍保留 data chunk", (info4.chunks || []).some(c => c.id === "data"));
}

console.log("\n══════ 乱码（中文歌词写入三种新格式） ══════");
{
  const chk = (label, info) => ok(`${label} 中文歌词无乱码`,
    info.metadata.lyrics && info.metadata.lyrics.includes("难以忘记初次见你") && !info.metadata.lyrics.includes("\uFFFD"),
    JSON.stringify((info.metadata.lyrics || "").slice(0, 16)));

  const m = M4A.read(M4A.write(buildM4A({ title: "x" }), { title: "七里香", lyrics: lrc }, M4A.read(buildM4A({ title: "x" }))));
  chk("M4A", m);
  const o = OGG.read(OGG.write(buildOGG({ TITLE: "x" }), { title: "七里香", lyrics: lrc }, OGG.read(buildOGG({ TITLE: "x" }))));
  chk("OGG", o);
  const w = WAV.read(WAV.write(buildWAV({ title: "x" }), { title: "七里香", lyrics: lrc }, WAV.read(buildWAV({ title: "x" }))));
  chk("WAV", w);
}

console.log("\n══════ 损坏/异常输入保护 ══════");
{
  ok("M4A.read 拒绝非MP4", M4A.read(new Uint8Array([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]).buffer) === null);
  ok("OGG.read 拒绝非OGG", OGG.read(new Uint8Array(64).fill(0).buffer) === null);
  ok("WAV.read 拒绝非RIFF", WAV.read(new Uint8Array(64).fill(0).buffer) === null);
  ok("M4A.read 拒绝空buffer", M4A.read(new Uint8Array(4).buffer) === null);
  ok("OGG.read 拒绝空buffer", OGG.read(new Uint8Array(4).buffer) === null);
  ok("WAV.read 拒绝空buffer", WAV.read(new Uint8Array(4).buffer) === null);
  // 截断的 MP4（moov 不完整）不应崩溃
  const trunc = buildM4A({ title: "x" }).slice(0, 30);
  let threw = false;
  try { M4A.read(trunc); } catch (e) { threw = true; }
  ok("M4A.read 截断文件不抛异常", !threw);
}

console.log("\n════════════════════════════════");
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log("════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
