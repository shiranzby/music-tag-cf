# 融合指南 — 把 music-tag-cf 的能力移植进你的网页播放器

> 面向读者：你（或帮你做播放器的 AI）
> 目标：不动播放器主体结构，把「标签读写 + 音源搜索 + 歌词同步」三块能力接进去
> 生成时间：2026-10-19 · 对应 music-tag-cf v2.2

---

## 0. 先看这个：两个模块分别解决什么问题

| 模块 | 文件 | 运行环境 | 解决什么 |
|---|---|---|---|
| **标签库** | `lib/music-tag.js` | 浏览器 / Node，**零依赖、无 DOM** | 读/写 MP3、FLAC、M4A、OGG、WAV 的标签、封面、音频属性；LRC 歌词逐行同步 |
| **音源 API** | `lib/worker-sources.js` | Cloudflare Worker（也可跑任何支持 fetch 的服务端） | 网易云 / QQ / Deezer 三源搜索、封面 URL、封面图片代理、歌词代理 |

**一句话**：播放器本地放歌 → 用 `music-tag.js` 读标签和封面；想补全/搜歌 → 用 `worker-sources.js`。

```
你的播放器
   │
   ├─ 本地文件 ──► music-tag.js ──► 标签/封面/音频属性（纯前端，文件不上传）
   │
   └─ 搜索/歌词 ──► worker-sources.js ──► 网易云/QQ/Deezer（服务端代理，绕 CORS）
```

---

## 1. 三分钟接入（最小改动）

### 步骤 1：复制文件

```bash
# 从 music-tag-cf 复制到你的播放器项目
cp music-tag-cf/lib/music-tag.js      <你的播放器>/src/lib/
cp music-tag-cf/lib/worker-sources.js <你的播放器>/src/lib/
```

> `music-tag.js` 是纯 ESM（`export`），可直接被 Vite / Webpack / 原生 `<script type="module">` 使用。

### 步骤 2：读本地文件的标签和封面

```html
<script type="module">
import { MusicTag, LRC } from "./src/lib/music-tag.js";

const input = document.querySelector("#fileInput");   // <input type="file" accept="audio/*">
input.addEventListener("change", async () => {
  const file = input.files[0];
  if (!file) return;

  const buf = await file.arrayBuffer();
  const info = MusicTag.read(buf);

  if (!info.format) { alert("不支持的格式"); return; }

  // ① 标签
  console.log(info.format, info.metadata);
  // info.metadata = { title, artist, album, albumArtist, composer,
  //                   year, track, disc, genre, comment, lyrics }  —— 全部为字符串

  // ② 封面 → <img>
  if (info.cover) {
    const url = URL.createObjectURL(new Blob([info.cover.data], { type: info.cover.mime }));
    document.querySelector("#coverImg").src = url;
  }

  // ③ 音频属性（FLAC 有完整信息；MP3 有 bitrate/sampleRate/channels）
  console.log(info.audioInfo);   // { bitrate, sampleRate, channels, bitDepth }

  // ④ 播放
  const audio = document.querySelector("#audio");
  audio.src = URL.createObjectURL(new Blob([buf], { type: file.type }));

  // ⑤ 歌词逐行同步
  audio.ontimeupdate = () => {
    document.querySelector("#lyricLine").textContent = LRC.lineAt(info.metadata.lyrics, audio.currentTime);
  };
});
</script>
```

到这一步，你的播放器已经能**显示任意音频文件的标签、封面、歌词**了。

### 步骤 3（可选）：接搜索 / 歌词补全

如果你的播放器有 Cloudflare Worker 后端：

```js
// worker.js（你的 Worker 入口）
import { handleMusicApi } from "./worker-sources.js";

export default {
  async fetch(request) {
    // 音乐 API 优先；返回 null 表示不是音乐路由，继续走你自己的
    const r = await handleMusicApi(request);
    if (r) return r;

    // ……你的播放器前端 / 其他 API……
    return new Response("ok");
  },
};
```

前端调用：

```js
// 搜歌
const res = await fetch("/api/tag/search?q=周杰伦&source=both");
const { results } = await res.json();
// results: [{ source, id, title, artist, album, cover, duration, year, track, ... }]

// 用搜索结果补全当前歌曲标签（本地写入，不上传）
function applyResult(info, result) {
  const out = MusicTag.write(info._buf, {
    title: result.title,
    artist: result.artist,
    album: result.album,
    year: result.year,
    track: result.track,
    genre: result.genre,
  }, info);
  // out 是 ArrayBuffer —— 存起来 / 触发下载
  return out;
}
```

---

## 2. `music-tag.js` API 详解

### 2.1 统一门面（推荐用这两个）

```js
import { MusicTag, LRC } from "./music-tag.js";
```

#### `MusicTag.detect(buffer)`

识别格式。返回 `"mp3" | "flac" | "m4a" | "ogg" | "wav" | null`。

```js
MusicTag.detect(buf);   // "mp3"
```

#### `MusicTag.read(buffer)`

读取标签，返回统一结构：

| 字段 | 类型 | 说明 |
|---|---|---|
| `format` | string | `"mp3"`/`"flac"`/`"m4a"`/`"ogg"`/`"wav"`，无法识别为 `null` |
| `metadata` | object \| null | 11 个字段全部存在（空串补齐），见下表 |
| `cover` | object \| null | `{ mime: "image/jpeg", data: Uint8Array }` |
| `audioInfo` | object \| null | `{ bitrate, sampleRate, channels, bitDepth }`（FLAC 完整；MP3 有前三项） |
| `writable` | boolean | 该格式是否支持写回 |
| `raw` | object \| null | 各解析器原始结果，**写回时必须原样传回** |

`metadata` 字段表（全部小写字符串）：

| 字段 | 含义 | MP3 帧 | FLAC/OGG | M4A | WAV |
|---|---|---|---|---|---|
| `title` | 标题 | TIT2 | TITLE | ©nam | INAM |
| `artist` | 艺术家 | TPE1 | ARTIST | ©ART | IART |
| `albumArtist` | 专辑艺术家 | TPE2 | ALBUMARTIST | aART | — |
| `composer` | 作曲 | TCOM | COMPOSER | ©wrt | — |
| `album` | 专辑 | TALB | ALBUM | ©alb | IPRD |
| `year` | 年份 | TYER/TDRC | DATE/YEAR | ©day | ICRD |
| `track` | 音轨号 | TRCK | TRACKNUMBER | trkn | ITRK |
| `disc` | 碟号 | TPOS | DISCNUMBER | disk | — |
| `genre` | 流派 | TCON | GENRE | ©gen | IGNR |
| `comment` | 备注 | COMM | COMMENT | ©cmt | ICMT |
| `lyrics` | 歌词 | USLT | LYRICS | ©lyr | ILYR |

#### `MusicTag.write(buffer, tags, info)`

写回标签。**只传要改的字段**，返回新 `ArrayBuffer`。

```js
const out = MusicTag.write(buf, { title: "新标题", lyrics: "[00:01.00]歌词" }, info);
// out → new Blob([out], {type:"audio/mpeg"}) → 下载或播放
```

> ⚠️ `info` 必须是 `MusicTag.read()` 的返回值（内部携带格式状态）。
> 格式不支持时原样返回入参 buffer，不会抛异常。

### 2.2 歌词同步

```js
LRC.parse(text)          // → [{ time: 12.57, text: "难以忘记初次见你" }, ...]
LRC.lineAt(text, sec)    // → 当前秒数应显示的那一行（无匹配返回 ""）
```

支持 `[mm:ss.xx]` / `[mm:ss.xxx]` / `[mm:ss]`，一行多个时间标签也可。

### 2.3 五个独立解析器（高级用法）

```js
import { ID3, FLAC, M4A, OGG, WAV } from "./music-tag.js";

ID3.read(buffer)   // → { frames, cover, version, _rawFrames, tagSize }
ID3.write(buffer, tags, originalId3)
FLAC.read/write    // FLAC.read → { blocks, metadata, cover, isFLAC, audioData, streamInfo }
M4A.read/write     // M4A.read → { metadata, isM4A, ilstOffset, ilstSize, ancestors }
OGG.read/write     // OGG.read → { metadata, isOGG, vendor, fields, pages, serial }
WAV.read/write     // WAV.read → { metadata, isWAV, chunks }
```

一般不需要直接用，门面已覆盖。

---

## 3. `worker-sources.js` API 详解

### 3.1 路由表

| 方法 | 路径 | 参数 | 返回 |
|---|---|---|---|
| GET | `/api/tag/search` | `q`（必填）、`source=netease\|qq\|deezer\|both` | `{ source, results: [...] }` |
| GET | `/api/cover/album` | `id`（网易云歌曲 ID） | `{ picUrl }` |
| GET | `/api/cover/proxy` | `url`（图片地址） | 图片二进制 |
| GET | `/api/lyrics/fetch` | `id`（网易云歌曲 ID） | `{ lyrics }`（LRC 文本） |
| POST | `/api/metadata/write` | multipart: `file` + `metadata` | 改写后的音频文件（**可选**，浏览器端已能写，一般不用） |

### 3.2 搜索结果字段

```js
{
  source: "netease" | "qq" | "deezer",
  id: "歌曲ID（字符串）",
  title: "歌名",
  artist: "艺术家（多人用 / 分隔）",
  album: "专辑",
  albumId: "专辑ID",
  duration: 毫秒,
  year: "年份（Deezer 有，网易云/QQ 无）",
  track: "音轨号（Deezer 有）",
  disc: "碟号（Deezer 有）",
  genre: "流派（Deezer 有）",
  cover: "封面URL 或 null",
}
```

### 3.3 各源实测状态（2026-10-19）

| 源 | 状态 | 说明 |
|---|---|---|
| 网易云 | ✅ 稳定 | 3 UA 轮换 + 60s 缓存 + 3 次重试。**唯一有歌词的源** |
| QQ音乐 | ✅ 可用 | 多 UA/Referer 组合 |
| Deezer | ✅ 稳定 | 官方公开 API，中文可搜，1000px 封面 |
| 咪咕 | ❌ 已删 | 地域限制，3/3 实测失败 |
| Apple Music | ❌ 已删 | 中文恒 0 条 + 429 限流 |

**歌词只能来自网易云**。若搜索结果来自 QQ/Deezer，需自己用「标题+艺术家」再查一次网易云拿 `id`，再调 `/api/lyrics/fetch`。参考实现见 `src/template.html` 的 `App.fetchLyricsForEntry()`。

---

## 4. 播放器场景完整示例

下面是一段"能跑"的参考代码，覆盖：加载本地文件 → 显示标签/封面 → 播放 → 歌词同步 → 搜索补全 → 保存。

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Player</title></head>
<body>
  <input type="file" id="file" accept="audio/*">
  <img id="cover" width="200">
  <div id="meta"></div>
  <audio id="audio" controls></audio>
  <div id="lyric" style="font-size:20px"></div>
  <hr>
  <input id="q" placeholder="歌名"><button id="search">搜索补全</button>
  <div id="results"></div>

<script type="module">
import { MusicTag, LRC } from "./src/lib/music-tag.js";

const $ = s => document.querySelector(s);
const audio = $("#audio");
let current = null;   // { buf, info }

// ── 加载本地文件 ──
$("#file").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  const buf = await file.arrayBuffer();
  const info = MusicTag.read(buf);
  current = { buf, info };

  $("#meta").textContent =
    `${info.format} · ${info.metadata.title || file.name} — ${info.metadata.artist || "未知"}` +
    (info.audioInfo ? ` · ${info.audioInfo.sampleRate || ""}Hz` : "");

  if (info.cover) $("#cover").src = URL.createObjectURL(new Blob([info.cover.data], { type: info.cover.mime }));

  audio.src = URL.createObjectURL(new Blob([buf], { type: file.type || "audio/mpeg" }));
});

// ── 歌词同步 ──
audio.ontimeupdate = () => {
  if (!current) return;
  $("#lyric").textContent = LRC.lineAt(current.info.metadata.lyrics, audio.currentTime);
};

// ── 搜索补全 ──
$("#search").addEventListener("click", async () => {
  const q = $("#q").value.trim(); if (!q) return;
  const { results } = await (await fetch(`/api/tag/search?q=${encodeURIComponent(q)}&source=both`)).json();
  $("#results").innerHTML = results.slice(0, 5).map((r, i) =>
    `<div data-i="${i}" style="cursor:pointer;padding:4px">
       ${r.title} — ${r.artist} <small>[${r.source}]</small>
     </div>`).join("");
  $("#results").onclick = async ev => {
    const i = ev.target.dataset?.i; if (i === undefined) return;
    const r = results[i];

    // 1) 写入标签（本地，不上传）
    const out = MusicTag.write(current.buf, {
      title: r.title, artist: r.artist, album: r.album,
      year: r.year, track: r.track, genre: r.genre,
    }, current.info);
    current = { buf: out, info: MusicTag.read(out) };
    $("#meta").textContent = `${r.title} — ${r.artist}`;
    audio.src = URL.createObjectURL(new Blob([out], { type: "audio/mpeg" }));

    // 2) 拉歌词（只有网易云能拉；QQ/Deezer 结果需回退再搜一次拿 id）
    if (r.source === "netease") {
      const { lyrics } = await (await fetch(`/api/lyrics/fetch?id=${r.id}`)).json();
      if (lyrics) {
        const out2 = MusicTag.write(current.buf, { lyrics }, current.info);
        current = { buf: out2, info: MusicTag.read(out2) };
        $("#lyric").textContent = "歌词已就绪，播放看看";
      }
    }
  };
});
</script>
</body></html>
```

---

## 5. 注意事项与坑（重要）

1. **文件不上传**：`music-tag.js` 全部在浏览器内存 `ArrayBuffer` 中完成，符合"本地播放器"隐私预期。
2. **封面要 `URL.createObjectURL`**：`info.cover.data` 是 `Uint8Array`，不能直接当 src。
3. **`info` 只能配套使用**：`MusicTag.write(buf, tags, info)` 的第三个参必须是同一个文件 `MusicTag.read()` 的返回值。跨文件混用会写坏。
4. **一次写入只更新部分字段**：`write` 是"增量合并"，未传的字段保持原值（OGG/M4A/WAV 会保留未识别的原始标签，MP3 会透传未知帧）。
5. **M4A 写入有前提**：原文件必须已含 `ilst` 元数据区（绝大多数播放器导出的 m4a 都有）。若没有，`write` 原样返回、不改动，不会损坏文件。
6. **歌词源单一**：只有网易云有歌词。这是上游限制，不是 bug。
7. **搜索是第三方非官方接口**：网易云/QQ 为逆向网页接口，可能随时失效或限流。 Deezer 是官方公开 API，相对稳。
8. **Node 里跑要 ESM**：`music-tag.js` 用 `export`，Node 需 `import`（`.mjs` 或 `package.json` 里 `"type":"module"`）。
9. **`package.json` 别全装依赖**：`music-tag-cf` 的 devDependencies 含 playwright（很大）。你只需要这两个 js 文件，不需要它的 node_modules。

---

## 6. 保持同步（重要）

`lib/` 下的两个文件是**从 `src/` 自动抽取的副本**，不要手改：

```bash
cd music-tag-cf
node tools/build-lib.cjs          # template.html → lib/music-tag.js
node tools/build-worker-lib.cjs   # worker.js    → lib/worker-sources.js
```

| 你想改什么 | 改哪里 |
|---|---|
| 标签读写逻辑（MP3/FLAC/M4A/OGG/WAV） | `src/template.html` 里的 `ID3/FLAC/M4A/OGG/WAV` 段 → 重新生成 |
| 音源搜索 / 代理 | `src/worker.js` → 重新生成 |
| 歌词解析 LRC | `src/template.html` 的 `_getLyricLine` → 已抽到 `LRC` 模块 |

**验证命令**（改完必跑）：

```bash
node test_full.cjs      # MP3/FLAC 57 项
node test_formats.cjs   # M4A/OGG/WAV 51 项
node test_lib.mjs       # lib/ 独立可用性 53 项
```

三项全绿才算改动安全。

---

## 7. 文件清单

```
music-tag-cf/
├── lib/
│   ├── music-tag.js        # ← 复制这个（标签库，浏览器/Node 通用）
│   └── worker-sources.js   # ← 复制这个（音源 API，Worker 用）
├── tools/
│   ├── build-lib.cjs           # 生成 music-tag.js
│   └── build-worker-lib.cjs    # 生成 worker-sources.js
├── test_lib.mjs            # lib 独立可用性测试
└── INTEGRATION.md          # 本文件
```
