# 🎵 Music Tag Editor — Cloudflare Native Edition

> 浏览器端音乐元数据编辑器。零服务器成本，所有操作在本地浏览器内存中完成，文件不上传。

[![Version](https://img.shields.io/badge/version-v2.1-blue)](https://musictag.cc.cd)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-orange)](https://workers.cloudflare.com)

<img width="2537" height="1400" alt="image" src="https://github.com/user-attachments/assets/88ad5b4b-4b66-44a9-8101-8da0d78452cb" />


<p align="center">
  <b>🌐 在线体验：</b><a href="https://musictag.cc.cd">demo</a>
</p>

## ✨ 特性

### 🎯 核心功能

- **ID3v2.2 / 2.3 / 2.4 完整读写** — 浏览器端纯 JavaScript 二进制解析器，零外部依赖，支持标题 / 艺术家 / 专辑 / 年份 / 音轨 / 碟号 / 流派 / 作曲 / 专辑艺术家 / 备注全部字段
- **FLAC Vorbis Comment 浏览器端读写** — 支持 PICTURE 块封面解析与写入，支持 STREAMINFO 音频属性提取
- **网易云音乐自动刮削** — 搜索歌曲后一键应用标题 / 艺术家 / 专辑 / 封面 / 歌词，自动拉取专辑封面和 LRC 歌词
- **音乐播放器** — 内嵌音频播放，支持 LRC 歌词逐行同步显示，四种播放模式（顺序 / 单曲循环 / 列表循环 / 随机）

### 🎨 用户体验

- **文件不上传** — 所有操作在浏览器 ArrayBuffer 中完成，Worker 仅代理第三方 API 请求
- **拖拽批量上传** — 支持 MP3 / FLAC / M4A / OGG / WAV，SHA-256 跨批次自动去重
- **封面管理** — 更换 / 移除 / 从网易云自动下载封面，支持 MP3 和 FLAC 封面透传
- **批量操作** — 全选 / 反选、批量保存、批量下载、批量重命名（歌手-歌曲 / 歌曲-歌手）
- **莫奈配色** — 6 色操作按钮配色，暗 / 亮双主题，Web Component 涟漪动画主题切换
- **Ctrl+S 快捷键保存** — 即时写入标签到内存

### 🔧 技术特性

- **零前端依赖** — 2785 行单文件 SPA（HTML + CSS + JS），无框架、无构建工具
- **五层解码链** — UTF-8 → BOM 检测 → GBK → Big5 → Latin-1，彻底解决中文乱码，适配中英俄日韩等语言
- **Worker API 代理** — 网易云音乐搜索 / 歌词 / 封面 / CDN 代理，Cloudflare Workers 无服务器运行
- **响应式布局** — 桌面 3 列 / 平板 2 列 / 手机 1 列，40+ @media 断点精心适配
- **View Transitions API** — 主题切换涟漪扩散动画（Chrome 111+）

---

## 🚀 一键部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shiranzby/music-tag-cf)

> 点击上方按钮直接部署到你的 Cloudflare Workers 账号。也可手动部署：

```bash
git clone https://github.com/shiranzby/music-tag-cf.git
cd music-tag-cf
npm install
npx wrangler login
# 修改 wrangler.toml 中的 account_id
npm run deploy
```

---

## 🎯 使用方法

### 🌐 网页界面使用

1. **上传文件** — 拖拽音乐文件到虚线区域，或点击浏览选择文件。支持 MP3 / FLAC / M4A / OGG / WAV
2. **编辑标签** — 点击左侧文件列表中任意文件，右侧即显示完整标签编辑器
3. **搜索标签** — 在搜索框输入歌名（或留空自动提取），选择搜索来源，点击搜索即可获取网易云等平台的元数据
4. **一键应用** — 点击搜索结果中的"应用"按钮，自动填充标题 / 艺术家 / 专辑 / 封面 / 歌词
5. **更换封面** — 点击"更换封面"选择本地图片，或点击"移除封面"清除
6. **保存与下载** — 点击"保存编辑"将修改写入内存，点击"下载文件"输出修改后的音频
7. **批量操作** — 勾选多个文件后，使用批量保存 / 批量下载 / 批量重命名

### 🎵 音乐播放

- **双击文件列表中的歌曲** 即可开始播放
- 播放器面板同步显示 **LRC 歌词**（按时间戳逐行匹配）
- 桌面端播放器在编辑区右侧，移动端固定在底部
- 四种模式：🔁 列表循环 → 🔂 单曲循环 → 🔀 随机播放 → 顺序播放

### 🎨 主题切换

- 点击 Header 区域的 **日月按钮** 切换暗 / 亮主题
- 使用 **View Transitions API** 实现涟漪扩散过渡动画
- 主题偏好自动保存到 `localStorage`

****

## ⚙️ API 路由

所有 API 端点均由 Cloudflare Worker 提供，前端 SPA 直接调用。

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| `GET` | `/` | — | 返回前端 SPA 页面 |
| `GET` | `/api/tag/search` | `q`（查询词）, `source`（来源） | 音乐搜索代理（netease / qq / migu / both） |
| `GET` | `/api/cover/album` | `id`（歌曲 ID） | 网易云专辑封面获取（song/detail API） |
| `GET` | `/api/cover/proxy` | `url`（封面图片 URL） | 图片 CDN 代理（绕过 CORS） |
| `GET` | `/api/lyrics/fetch` | `id`（歌曲 ID） | 网易云歌词代理 |
| `POST` | `/api/metadata/write` | `file` + `metadata`（multipart） | Worker 端元数据写入（FLAC fallback） |

### 搜索来源说明

| source 值 | 对应 API | 可用性 | 备注 |
|-----------|----------|:---:|------|
| `netease` | music.163.com | ✅ 稳定 | 3 UA 轮换 + 60s 缓存 + 重试 |
| `qq` | c.y.qq.com | ⚠️ 受限 | 多 UA/Referer 组合，可能被反爬拦截 |
| `migu` | music.migu.cn | ⚠️ 受限 | 3 端点回退，CF 出口 IP 可能受限 |
| `both` | 三源并行 | ✅ 推荐 | 并行请求三源，合并去重返回 |

---

## 🛠️ 技术架构

### 🔧 核心技术

- **前端**：Vanilla JS（零框架）+ ID3v2 二进制解析器 + FLAC 容器读写器
- **后端**：Cloudflare Workers（ES modules）+ 内置 KV 缓存（60s TTL）
- **部署**：Wrangler CLI v4，单命令 `npm run deploy`
- **编码方案**：五层自适应解码链（UTF-8 → BOM → GBK → Big5 → Latin-1）
- **主题系统**：Web Component (Shadow DOM) + View Transitions API + localStorage 持久化

### 🎨 设计架构

- **单文件 SPA** — 全部前端代码在单个 `template.html`（HTML + CSS + JS 内联）中
- **双轨制播放** — `preparePlayer()`（显示 UI，不中断当前播放）+ `playAudio()`（加载 src 并播放）
- **封面生命周期** — `blob:` URL 精确管理，切换/移除/还原时正确释放，防止内存泄漏
- **状态一致性** — `saveCurrentToMemory()` 在每次标签页切换 / 搜索 / 保存前同步 UI → 内存

### 🔒 安全与性能

- **文件不上传** — 所有解析和写入在浏览器 `ArrayBuffer` 中完成
- **SHA-256 去重** — 跨批次检测重复文件，避免重复处理
- **封面代理白名单** — Worker 端仅代理 `*.music.126.net`、`*.qpic.cn` 域名
- **搜索缓存** — 60s 内存缓存，减少对网易云 API 的重复请求
- **100MB 文件上限** — 超大文件过滤，保护 Worker 内存

---

## 📁 项目结构

```
music-tag-cf/
├── package.json                # 依赖配置（wrangler v4）
├── wrangler.toml               # Worker 部署配置
├── README.md                   # 项目文档
├── issues.md                   # 已知问题 & 修复记录
├── .context_recovery.md        # 会话恢复上下文
├── .gitignore
├── src/
│   ├── template.html           # 🔴 核心文件 — 前端 SPA（2785 行）
│   │                           #   · CSS：暗/亮主题变量 + 40+ @media 响应式
│   │                           #   · JS：ID3v2 Reader/Writer + FLAC Reader/Writer
│   │                           #   · JS：App 状态管理 + 播放器 + 搜索 + 封面
│   │                           #   · JS：ThemeButton v4.0 Web Component
│   ├── worker.js               # 🔴 Worker API（633 行）
│   │                           #   · 网易云/QQ/咪咕 搜索代理（UA轮换+重试）
│   │                           #   · 封面/CDN 代理 + 歌词代理 + FLAC 写入
│   ├── worker_base.js          # 工具模块（86 行）
│   │                           #   · CORS 处理 / JSON 响应 / fetchWithRetry
│   └── template_v1.0.html      # v1.0 历史备份
├── test_bom.js                 # BOM 检测单元测试
├── test_decodeAny.js           # decodeAny 5 场景验证
├── test_lyrics.js              # GBK 歌词解码测试
└── test_utf8first.js           # UTF-8 优先策略测试
```

---

## 🎨 设计特色

### 🎯 用户界面

- **莫奈配色** — 6 色操作按钮（蓝 / 绿 / 紫 / 橙 / 粉 / 青），每色对应不同功能语义
- **音质标签** — Hi-Res（粉色）/ HQ（绿色）/ SQ（紫色）/ CD 品质（蓝色）自动检测
- **封面缩略图** — 文件列表中显示歌曲封面缩略图，编辑器封面严格正方形展示
- **编辑器 2 列 Grid** — 标签字段左右分栏，封面+播放器上置，操作栏底置，信息密度合理
- **文件列表 sticky header** — 滚动时固定操作按钮，无需回顶

### 🎨 视觉体验

- **涟漪主题切换** — 点击日月按钮，从点击位置扩散的圆形动画过渡（View Transitions API）
- **涟漪星辰动画** — sun/moon toggle 按钮带 hover 星球运动 + 星空闪烁
- **隐藏滚动条** — 文件列表和编辑器区域滚动条完全隐藏，视觉干净
- **主题默认** — 跟随系统变化 `prefers-color-scheme`

---

## 📱 移动端优化

### 🔄 适配策略

- **768px 断点** — 三列布局切换为单列纵向堆叠
- **播放器切换** — 桌面端侧边栏播放器 → 移动端底部固定播放条
- **文件列表高度** — 移动端 25vh 限制，防止上传区域被挤出屏幕
- **触摸友好** — 按钮最小触控区域 ≥ 6px padding，间距合理
- **封面正方形** — 移动端 `max-width: 160px`，不下压编辑器

### 📋 功能适配

- 操作栏按钮两行分组显示，自适应 `flex-wrap`
- 搜索栏一行排列（输入框 + 来源选择 + 搜索按钮），不换行
- 格式显示字体缩小至 0.65rem

---

## 🔧 本地开发

```bash
# 克隆项目
git clone https://github.com/shiranzby/music-tag-cf.git
cd music-tag-cf

# 安装依赖
npm install

# 启动本地开发服务器
npm run dev
# → http://localhost:8787
```

> Wrangler 会自动注入 `template.html` 到 Worker，本地修改即时生效。

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。请在 PR 中说明修改原因和影响范围。

---

## 📄 许可证

MIT License

---

## 🌟 更新日志

### v2.1 — 播放器增强与 UI 完善（V36-V57 · 22 轮迭代）

- ✅ SHA-256 跨批次去重 + 去重 toast 文件名提示
- ✅ 音乐播放器：LRC 歌词逐行同步、四种播放模式（顺序/单曲循环/列表循环/随机）
- ✅ 播放器不中断切换：`preparePlayer` 仅更新 UI，`playAudio` 加载音频
- ✅ 莫奈配色 6 色操作按钮 + 控件高度压缩 + sticky file-list-header
- ✅ 封面即时更新 + 还原封面清理 + 静音切换 + 随机播放
- ✅ 37+ UI 优化：对齐、间距、滚动、布局、歌词闪变

### v2.0 — 重大功能更新（V8-V35 · 26 轮迭代）

- ✅ **音乐播放器** — 内嵌音频播放 + 移动端固定底部播放条
- ✅ **莫奈配色** — 6 色操作按钮主题化
- ✅ **封面架构重写** — 网易云 API 封面获取链路修复 + 异步加载
- ✅ **响应式重构** — 桌面 3 列布局 + 40+ 媒体断点
- ✅ **波形图** — 音质 Info Panel + 格式/音质标签
- ✅ **批量操作完善** — 批量重命名实际生效 + 批量保存/下载
- ✅ 搜索分页 5 条/页 + 封面 120px 3 行 + 操作按钮分组
- ✅ Theme v4.0 涟漪动画 + 暗/亮系统自动检测

### v1.x — 核心功能实现

- ✅ ID3v2.2 / 2.3 / 2.4 Reader & v2.3 Writer（纯浏览器端）
- ✅ FLAC Vorbis Comment 浏览器端 Reader & Writer
- ✅ 五层编码解码链（UTF-8 → BOM → GBK → Big5 → Latin-1）
- ✅ 网易云音乐 / QQ 音乐 / 咪咕音乐三源搜索
- ✅ 封面管理（更换 / 移除 / 透传）+ 歌词代理
- ✅ 文件名解析 + 批量重命名 + 文件去重
- ✅ 暗亮主题切换（localStorage 持久化）
- ✅ Worker API 代理 + CORS 处理

---

## 🙏 致谢

- **Cloudflare Workers** — 提供零服务器成本的边缘计算平台
- **网易云音乐 API** — 标签搜索与封面数据的核心数据源
- **ID3v2 规范** — http://id3.org/
- **View Transitions API** — Chrome 团队提供的声明式过渡动画

---

> 🎵 让每一首歌的元数据都整整齐齐
