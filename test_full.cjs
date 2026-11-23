/**
 * music-tag-cf 全面回归测试
 * 覆盖：MP3 / FLAC 增改查删、歌词写入、多编码乱码、未知帧透传、二次写入不损坏
 * 运行：node test_full.cjs
 */
const fs = require("fs");
const path = process.argv[2] || "F:/WorkSpace/Workbuddy/Github项目分析部署/music-tag-cf/src/template.html";
const html = fs.readFileSync(path, "utf8");

// ── 抽取 ID3 + FLAC 纯逻辑（不依赖 DOM） ──
const start = html.indexOf("const ID3 = {};");
const end = html.indexOf("  Application State & Logic");
if (start < 0 || end < 0) { console.error("抽取失败"); process.exit(1); }
let code = html.slice(start, end);
code = code.slice(0, code.lastIndexOf("// ═"));
const { ID3, FLAC } = new Function(code + "\n return {ID3, FLAC};")();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? " → " + extra : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? " → " + extra : ""}`); }
};

// ═══ 工具：构造 MP3（无 tag 的纯音频） ═══
const mp3_audio = new Uint8Array(1024).fill(0x41);

// ═══ 工具：构造 FLAC（fLaC + STREAMINFO + VORBIS_COMMENT + audio） ═══
function buildFLAC(fields = {}, audioLen = 512) {
  const vendor = "reference libFLAC 1.3.2";
  const vendorB = new TextEncoder().encode(vendor);
  const entries = Object.entries(fields).filter(([, v]) => v);
  const fieldBs = entries.map(([k, v]) => new TextEncoder().encode(`${k}=${v}`));
  let vcSize = 4 + vendorB.length + 4 + fieldBs.reduce((s, b) => s + 4 + b.length, 0);
  const vc = new Uint8Array(4 + vcSize);
  vc[0] = 0x84; // last-block(0x80) | type 4 = VORBIS_COMMENT
  vc[1] = (vcSize >> 16) & 0xff; vc[2] = (vcSize >> 8) & 0xff; vc[3] = vcSize & 0xff;
  let p = 4;
  const dv = new DataView(vc.buffer);
  dv.setUint32(p, vendorB.length, true); p += 4;
  vc.set(vendorB, p); p += vendorB.length;
  dv.setUint32(p, entries.length, true); p += 4;
  for (const fb of fieldBs) { dv.setUint32(p, fb.length, true); p += 4; vc.set(fb, p); p += fb.length; }

  const si = new Uint8Array(34);
  si[10] = 0x0A; si[11] = 0xC4; si[12] = 0x42; si[13] = 0xF0; // 44.1kHz / 2ch / 16bit
  const siBlock = new Uint8Array(4 + 34);
  siBlock[0] = 0x00; // STREAMINFO, not last
  siBlock[1] = 0; siBlock[2] = 0; siBlock[3] = 34;
  siBlock.set(si, 4);

  const audio = new Uint8Array(audioLen).fill(0x7A);
  const out = new Uint8Array(4 + siBlock.length + vc.length + audio.length);
  out.set([0x66, 0x4C, 0x61, 0x43], 0); // "fLaC"
  let o = 4;
  out.set(siBlock, o); o += siBlock.length;
  out.set(vc, o); o += vc.length;
  out.set(audio, o);
  return out.buffer;
}

console.log("\n══════ 1. MP3 增 / 改 / 查 ══════");
{
  const buf = ID3.write(mp3_audio.buffer, {
    title: "七里香", artist: "周杰伦", album: "七里香",
    albumArtist: "周杰伦", composer: "周杰伦", year: "2004",
    track: "1/10", disc: "1/1", genre: "Mandarin Pop", comment: "测试备注",
  }, null);
  const r = ID3.read(buf);
  ok("写入→读回 title(中文)", r.frames.title === "七里香", r.frames.title);
  ok("artist", r.frames.artist === "周杰伦", r.frames.artist);
  ok("album", r.frames.album === "七里香");
  ok("albumArtist", r.frames.albumArtist === "周杰伦");
  ok("composer", r.frames.composer === "周杰伦");
  ok("year", r.frames.year === "2004");
  ok("track", r.frames.track === "1/10");
  ok("disc", r.frames.disc === "1/1");
  ok("genre", r.frames.genre === "Mandarin Pop");
  ok("comment", r.frames.comment === "测试备注");

  // 改：第二次写入覆盖
  const buf2 = ID3.write(buf, { title: "夜曲", artist: "周杰伦" }, r);
  const r2 = ID3.read(buf2);
  ok("改写 title", r2.frames.title === "夜曲", r2.frames.title);
  ok("改后音频区保留(长度一致)", buf2.byteLength > 1024);
}

console.log("\n══════ 2. MP3 歌词写入（核心 bug） ══════");
{
  const lrc = "[00:00.000] 作词 : 方文山\n[00:12.570]窗外的麻雀\n[00:16.860]在电线杆上多嘴";
  const buf = ID3.write(mp3_audio.buffer, { title: "七里香", lyrics: lrc }, null);
  const r = ID3.read(buf);
  ok("歌词写入→读回", r.frames.lyrics && r.frames.lyrics.includes("窗外的麻雀"),
    JSON.stringify((r.frames.lyrics || "").slice(0, 30)));
  ok("歌词含 LRC 时间轴", (r.frames.lyrics || "").includes("[00:12.570]"));

  // 二次写入不丢歌词
  const buf2 = ID3.write(buf, { title: "七里香", lyrics: lrc }, r);
  const r2 = ID3.read(buf2);
  ok("二次写入歌词仍在", (r2.frames.lyrics || "").includes("电线杆上多嘴"));
}

console.log("\n══════ 3. MP3 封面 增 / 删 ══════");
{
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02, 0x03]);
  const buf = ID3.write(mp3_audio.buffer, { title: "带封面", _newCover: { mime: "image/png", data: png } }, null);
  const r = ID3.read(buf);
  ok("封面写入", !!r.cover, r.cover ? r.cover.mime : "null");
  ok("封面数据完整", r.cover && r.cover.data.length === png.length);

  // 移除封面
  const buf2 = ID3.write(buf, { title: "带封面", _removeCover: true }, r);
  const r2 = ID3.read(buf2);
  ok("封面移除", !r2.cover, r2.cover ? "仍存在" : "已移除");
}

console.log("\n══════ 4. 乱码测试（多编码 / 多语种） ══════");
{
  // 4.1 写入端：UTF-8 写入各种语言，读回比对
  const cases = [
    ["中文", "难以忘记初次见你"],
    ["日文", "桜の花が咲く頃"],
    ["韩文", "블랙핑크 인 유어 에리어"],
    ["emoji", "🎵🎶 音乐 ♪"],
    ["繁体", "難以忘記初次見你"],
    ["混排", "周杰伦-Jay Chou 七里香 2004"],
  ];
  for (const [label, text] of cases) {
    const buf = ID3.write(mp3_audio.buffer, { title: text, lyrics: text }, null);
    const r = ID3.read(buf);
    ok(`写入读回 ${label}`, r.frames.title === text, JSON.stringify(r.frames.title));
    ok(`歌词 ${label} 无乱码`, r.frames.lyrics === text);
  }

  // 4.2 读取端：模拟老文件（编码字节误标 / 无 BOM / GBK）
  ok("decodeAny UTF-16LE+BOM", ID3.decodeAny(new Uint8Array([0xFF, 0xFE, 0x2D, 0x4E, 0x87, 0x65])) === "中文",
    JSON.stringify(ID3.decodeAny(new Uint8Array([0xFF, 0xFE, 0x2D, 0x4E, 0x87, 0x65]))));
  ok("decodeAny UTF-16BE+BOM", ID3.decodeAny(new Uint8Array([0xFE, 0xFF, 0x4E, 0x2D, 0x65, 0x87])) === "中文",
    JSON.stringify(ID3.decodeAny(new Uint8Array([0xFE, 0xFF, 0x4E, 0x2D, 0x65, 0x87]))));
  // GBK "中文" = D6 D0 CE C4
  const gbk = ID3.decodeAny(new Uint8Array([0xD6, 0xD0, 0xCE, 0xC4]));
  ok("decodeAny GBK 回退", gbk === "中文", JSON.stringify(gbk));
  // 前缀 0x00 + UTF-16 BOM（真实脏数据）
  const dirty = ID3.decodeAny(new Uint8Array([0x00, 0xFF, 0xFE, 0x2D, 0x4E, 0x87, 0x65]));
  ok("decodeAny 剥离多余0x00+BOM", dirty === "中文", JSON.stringify(dirty));
  // encByte=0x01 声明 UTF-16，字节序自动切换
  ok("decodeAny encByte=1 (LE优先)", ID3.decodeAny(new Uint8Array([0x2D, 0x4E]), 0x01) === "中",
    JSON.stringify(ID3.decodeAny(new Uint8Array([0x2D, 0x4E]), 0x01)));
}

console.log("\n══════ 5. 未知帧透传（新功能：防标签丢失） ══════");
{
  // 构造一个含 TDRC + PRIV 的 MP3，再写一次，验证这些帧仍在
  const first = ID3.write(mp3_audio.buffer, { title: "原始标题" }, null);
  const r1 = ID3.read(first);
  // 注入三个「未被管理」的帧（模拟原文件携带：BPM / 私有帧 / 二进制对象）
  r1._rawFrames.push({ id: "TBPM", data: new Uint8Array([0x03, 0x31, 0x32, 0x38]) }); // "128"
  r1._rawFrames.push({ id: "PRIV", data: new Uint8Array([0x41, 0x42, 0x00, 0x01]) });
  r1._rawFrames.push({ id: "GEOB", data: new Uint8Array([0x03, 0x41, 0x00, 0x42]) });
  // TDRC(v2.4日期)属被管理帧：其语义由 v2.3 的 TYER 承载，不应重复透传
  r1._rawFrames.push({ id: "TDRC", data: new Uint8Array([0x03, 0x32, 0x30, 0x30, 0x34]) });
  const second = ID3.write(first, { title: "新标题", year: "2004" }, r1);
  const r2 = ID3.read(second);
  const ids = (r2._rawFrames || []).map(f => f.id);
  ok("TBPM 被透传保留", ids.includes("TBPM"), JSON.stringify(ids));
  ok("PRIV 被透传保留", ids.includes("PRIV"));
  ok("GEOB 被透传保留", ids.includes("GEOB"));
  ok("TDRC 不重复(由 TYER 承载年份)", !ids.includes("TDRC") && r2.frames.year === "2004",
    "year=" + r2.frames.year);
  ok("管理的帧不重复(TIT2 唯一)", ids.filter(i => i === "TIT2").length === 1,
    JSON.stringify(ids.filter(i => i === "TIT2")));
  ok("改写后 title 正确", r2.frames.title === "新标题");
}

console.log("\n══════ 6. FLAC 增 / 改 / 查 + 歌词 ══════");
{
  const buf = buildFLAC({ TITLE: "原始标题", ARTIST: "原始艺术家" });
  const info = FLAC.read(buf);
  ok("FLAC 识别", info && info.isFLAC);
  ok("FLAC 读 title", info.metadata.title === "原始标题", info.metadata.title);
  ok("STREAMINFO 解析", info.streamInfo && info.streamInfo.sampleRate === 44100,
    JSON.stringify(info.streamInfo));
  ok("audioData 保留", info.audioData && info.audioData.length === 512,
    info.audioData ? String(info.audioData.length) : "null");

  const lrc = "[00:12.570]FLAC歌词测试\n[00:16.860]第二行";
  const newMeta = { title: "新标题", artist: "周杰伦", album: "七里香", lyrics: lrc, year: "2004" };
  const buf2 = FLAC.write(buf, newMeta, info);
  const info2 = FLAC.read(buf2);
  ok("FLAC 改写 title", info2.metadata.title === "新标题", info2.metadata.title);
  ok("FLAC 写歌词", info2.metadata.lyrics && info2.metadata.lyrics.includes("FLAC歌词测试"),
    JSON.stringify((info2.metadata.lyrics || "").slice(0, 20)));
  ok("FLAC 改写后 fLaC 头有效", new Uint8Array(buf2.slice(0, 4)).join() === "102,76,97,67");
  ok("FLAC 音频数据保留", info2.audioData && info2.audioData.length === 512,
    info2.audioData ? String(info2.audioData.length) : "null");

  // 二次写入不损坏
  const buf3 = FLAC.write(buf2, { title: "新标题2", lyrics: lrc }, info2);
  const info3 = FLAC.read(buf3);
  ok("FLAC 二次写入可读", info3 && info3.isFLAC && info3.metadata.title === "新标题2", info3.metadata.title);
  ok("FLAC 二次写入歌词仍在", (info3.metadata.lyrics || "").includes("第二行"));
  ok("FLAC 二次写入音频保留", info3.audioData && info3.audioData.length === 512);
}

console.log("\n══════ 7. FLAC 封面 / 未管理字段保留 ══════");
{
  const buf = buildFLAC({ TITLE: "T", ARTIST: "A", CUSTOMFIELD: "自定义值" });
  const info = FLAC.read(buf);
  const buf2 = FLAC.write(buf, { title: "T2", artist: "A" }, info);
  const info2 = FLAC.read(buf2);
  ok("FLAC 未管理字段保留(CUSTOMFIELD)",
    (info2.vorbisComment.fields || []).some(f => f === "CUSTOMFIELD=自定义值"),
    JSON.stringify(info2.vorbisComment.fields));

  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x01, 0x02, 0x03, 0x04]);
  const buf3 = FLAC.write(buf, { title: "T", _newCover: { mime: "image/png", data: png } }, info);
  const info3 = FLAC.read(buf3);
  ok("FLAC 封面写入", !!info3.cover, info3.cover ? info3.cover.mime : "null");
}

console.log("\n══════ 8. 边界：空值 / 特殊字符 ══════");
{
  const buf = ID3.write(mp3_audio.buffer, { title: "" }, null);
  const r = ID3.read(buf);
  ok("空 title 不崩溃", r !== null);
  const buf2 = ID3.write(mp3_audio.buffer, { title: 'A&B<C>"D\'E' }, null);
  const r2 = ID3.read(buf2);
  ok("XML 特殊字符往返", r2.frames.title === 'A&B<C>"D\'E', JSON.stringify(r2.frames.title));
  const long = "长".repeat(500);
  const buf3 = ID3.write(mp3_audio.buffer, { title: long }, null);
  const r3 = ID3.read(buf3);
  ok("超长文本往返(500字)", r3.frames.title === long, "长度=" + (r3.frames.title || "").length);
}

console.log("\n════════════════════════════════");
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log("════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
