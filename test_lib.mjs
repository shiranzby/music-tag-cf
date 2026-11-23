/**
 * lib/music-tag.js 独立可用性验证（ESM import）
 * 验证门面 API：detect / read / write，以及 LRC 逐行同步
 * 运行：node test_lib.mjs
 */
import { MusicTag, LRC, ID3, FLAC, M4A, OGG, WAV } from "./lib/music-tag.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ✅ ${n}${extra ? " → " + extra : ""}`); }
  else { fail++; console.log(`  ❌ ${n}${extra ? " → " + extra : ""}`); }
};

const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let q = 0; for (const x of a) { o.set(x, q); q += x.length; } return o; };
const str = t => { const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i); return b; };
const u32be = v => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const u32le = v => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);

const crcTable = (() => { const t = []; for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1); t.push(r >>> 0); } return t; })();
const crc32 = b => { let c = 0; for (const x of b) c = (((c << 8) & 0xffffffff) ^ crcTable[((c >>> 24) & 0xff) ^ x]) >>> 0; return c >>> 0; };
const segOf = p => { const s = []; let l = p.length; while (l >= 255) { s.push(255); l -= 255; } s.push(l); return s; };

function buildOGG(fields, audioLen = 400) {
  const serial = 0x1A2B3C4D;
  const idh = cat(new Uint8Array([0x01]), str("vorbis"), u32le(0), new Uint8Array([2]), u32le(44100), u32le(0), u32le(160000), u32le(0), new Uint8Array([0xb8]), new Uint8Array([1]));
  const vb = str("music-tag-cf");
  const cbs = Object.entries(fields).filter(([, v]) => v).map(([k, v]) => new TextEncoder().encode(`${k}=${v}`));
  const ch = new Uint8Array(7 + 4 + vb.length + 4 + cbs.reduce((n, b) => n + 4 + b.length, 0) + 1);
  ch[0] = 0x03; ch.set(str("vorbis"), 1);
  let p = 7;
  ch.set(u32le(vb.length), p); p += 4; ch.set(vb, p); p += vb.length;
  ch.set(u32le(cbs.length), p); p += 4;
  for (const b of cbs) { ch.set(u32le(b.length), p); p += 4; ch.set(b, p); p += b.length; }
  ch[p] = 0x01;
  const mkPage = (type, granule, seq, packet) => {
    const seg = segOf(packet);
    const hdr = cat(str("OggS"), new Uint8Array([0, type]), new Uint8Array(8), u32le(serial), u32le(seq), new Uint8Array([0, 0, 0, 0]), new Uint8Array([seg.length]), new Uint8Array(seg));
    for (let i = 0; i < 8; i++) hdr[6 + i] = Math.floor(granule / Math.pow(256, i)) % 256;
    const page = cat(hdr, packet);
    const crc = crc32(page);
    page[22] = (crc >>> 24) & 255; page[23] = (crc >>> 16) & 255; page[24] = (crc >>> 8) & 255; page[25] = crc & 255;
    return page;
  };
  const audio = new Uint8Array(audioLen).fill(0x5A);
  return cat(mkPage(0x02, 0, 0, idh), mkPage(0x00, 0, 1, ch),
    mkPage(0x04, 8000, 2, cat(new Uint8Array([0x05]), str("vorbis"), new Uint8Array(20).fill(0x11))),
    mkPage(0x00, 16000, 3, audio));
}
function buildWAV(fields, audioLen = 300) {
  const chunks = [str("fmt "), u32le(16), new Uint8Array([1, 0]), new Uint8Array([2, 0]), u32le(44100), u32le(176400), new Uint8Array([4, 0]), new Uint8Array([16, 0])];
  const map = { INAM: "title", IART: "artist", IPRD: "album", ICRD: "year", IGNR: "genre", ITRK: "track", ICMT: "comment", ILYR: "lyrics" };
  const items = [];
  for (const [ck, key] of Object.entries(map)) {
    if (!fields[key]) continue;
    const v = new TextEncoder().encode(fields[key] + "\0");
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
    const txt = new TextEncoder().encode(val);
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

const lrc = "[00:00.000] 作词 : 方文山\n[00:12.570]难以忘记初次见你\n[00:16.860]一双迷人的眼睛";

console.log("\n════ 1. 导出完整性 ════");
ok("MusicTag 导出", typeof MusicTag === "object");
ok("LRC 导出", typeof LRC === "object");
ok("五个解析器导出", [ID3, FLAC, M4A, OGG, WAV].every(x => x && x.read && x.write));

console.log("\n════ 2. MusicTag.detect ════");
ok("识别 MP3", MusicTag.detect(ID3.write(new Uint8Array(256).fill(0x41).buffer, { title: "x" }, null)) === "mp3");
ok("识别 FLAC", MusicTag.detect(FLAC.write(buildFLAClike(), { title: "x" }, FLAC.read(buildFLAClike()))) === "flac");
ok("识别 M4A", MusicTag.detect(buildM4A({ title: "x" })) === "m4a");
ok("识别 OGG", MusicTag.detect(buildOGG({ TITLE: "x" })) === "ogg");
ok("识别 WAV", MusicTag.detect(buildWAV({ title: "x" })) === "wav");
ok("垃圾数据返回 null", MusicTag.detect(new Uint8Array(64).fill(0).buffer) === null);
ok("空 buffer 返回 null", MusicTag.detect(null) === null);

function buildFLAClike() {
  const vendor = "reference libFLAC 1.3.2";
  const vb = str(vendor);
  const cbs = [new TextEncoder().encode("TITLE=原标题")];
  let vcSize = 4 + vb.length + 4 + cbs.reduce((n, b) => n + 4 + b.length, 0);
  const vc = new Uint8Array(4 + vcSize);
  vc[0] = 0x84; vc[1] = (vcSize >> 16) & 255; vc[2] = (vcSize >> 8) & 255; vc[3] = vcSize & 255;
  let p = 4;
  const dv = new DataView(vc.buffer);
  dv.setUint32(p, vb.length, true); p += 4; vc.set(vb, p); p += vb.length;
  dv.setUint32(p, cbs.length, true); p += 4;
  for (const b of cbs) { dv.setUint32(p, b.length, true); p += 4; vc.set(b, p); p += b.length; }
  const si = new Uint8Array(34);
  si[10] = 0x0A; si[11] = 0xC4; si[12] = 0x42; si[13] = 0xF0;
  const siBlock = new Uint8Array(38);
  siBlock[0] = 0x00; siBlock[1] = 0; siBlock[2] = 0; siBlock[3] = 34; siBlock.set(si, 4);
  const audio = new Uint8Array(512).fill(0x7A);
  const body = cat(str("WAVE").slice(0, 0), siBlock, vc, audio);
  return cat(new Uint8Array([0x66, 0x4C, 0x61, 0x43]), body).buffer;
}

console.log("\n════ 3. 门面 read/write 全格式往返 ════");
const samples = {
  mp3: () => ID3.write(new Uint8Array(512).fill(0x41).buffer, { title: "原标题", artist: "周杰伦" }, null),
  flac: () => buildFLAClike(),
  m4a: () => buildM4A({ title: "原标题", artist: "周杰伦" }),
  ogg: () => buildOGG({ TITLE: "原标题", ARTIST: "周杰伦" }),
  wav: () => buildWAV({ title: "原标题", artist: "周杰伦" }),
};
for (const fmt of Object.keys(samples)) {
  const buf = samples[fmt]();
  const info = MusicTag.read(buf);
  ok(`${fmt}: detect`, info.format === fmt, info.format);
  ok(`${fmt}: metadata 非空`, info.metadata && (info.metadata.title || info.metadata.artist), JSON.stringify(info.metadata && info.metadata.title));
  ok(`${fmt}: writable`, info.writable === true);

  // 写回：改标题 + 写歌词
  const out = MusicTag.write(buf, { title: "七里香", artist: "周杰伦", lyrics: lrc }, info);
  const info2 = MusicTag.read(out);
  ok(`${fmt}: write→read title`, info2.metadata.title === "七里香", info2.metadata.title);
  ok(`${fmt}: 歌词写入无乱码`, info2.metadata.lyrics.includes("难以忘记初次见你") && !info2.metadata.lyrics.includes("\uFFFD"));

  // 二次写
  const out2 = MusicTag.write(out, { title: "夜曲" }, info2);
  const info3 = MusicTag.read(out2);
  ok(`${fmt}: 二次写入 title`, info3.metadata.title === "夜曲", info3.metadata.title);
}

console.log("\n════ 4. 封面读取 ════");
{
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x01, 0x02, 0x03]);
  const buf = ID3.write(new Uint8Array(256).fill(0x41).buffer, { title: "t", _newCover: { mime: "image/png", data: png } }, null);
  const info = MusicTag.read(buf);
  ok("MP3 封面提取", info.cover && info.cover.mime === "image/png", info.cover && info.cover.mime);
  ok("封面数据完整", info.cover && info.cover.data.length === png.length);
  // 播放器用法：直接转 blob URL
  const url = URL.createObjectURL(new Blob([info.cover.data], { type: info.cover.mime }));
  ok("封面可转 Blob URL", typeof url === "string" && url.startsWith("blob:"));
  URL.revokeObjectURL(url);
}

console.log("\n════ 5. LRC 逐行同步 ════");
{
  const parsed = LRC.parse(lrc);
  ok("LRC.parse 行数", parsed.length === 3, String(parsed.length));
  ok("LRC.parse 时间正确", parsed[1].time === 12.57, String(parsed[1].time));
  ok("LRC.parse 文本正确", parsed[1].text === "难以忘记初次见你", parsed[1].text);
  ok("t=0 显示作词行", LRC.lineAt(lrc, 0) === "作词 : 方文山", LRC.lineAt(lrc, 0));
  ok("t=13 显示第一句", LRC.lineAt(lrc, 13) === "难以忘记初次见你", LRC.lineAt(lrc, 13));
  ok("t=20 显示第二句", LRC.lineAt(lrc, 20) === "一双迷人的眼睛", LRC.lineAt(lrc, 20));
  ok("t=999 仍显示最后一句", LRC.lineAt(lrc, 999) === "一双迷人的眼睛");
  ok("空文本不崩", LRC.lineAt("", 10) === "" && LRC.parse(null).length === 0);
  // 一行多时间标签
  const multi = "[00:01.00][00:30.00]重复句";
  ok("一行多时间标签", LRC.parse(multi).length === 2 && LRC.parse(multi)[1].time === 30);
}

console.log("\n════ 6. audioInfo ════");
{
  const info = MusicTag.read(buildFLAClike());
  ok("FLAC STREAMINFO", info.audioInfo && info.audioInfo.sampleRate === 44100 && info.audioInfo.channels === 2 && info.audioInfo.bitDepth === 16,
    JSON.stringify(info.audioInfo));
}

console.log("\n════════════════════════════════");
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log("════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
