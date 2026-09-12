# 漫画正版导航（Manga Legal Navigator）

**打开漫画页面 → 立刻知道这部作品在 DLsite / FANZA / Melonbooks 上有没有正版，以及在哪里买。**

`manga-legal-navigator` 是一个 Manifest V3 的 Chrome / Chromium 扩展。它读取你正在看的页面，识别作品名（优先日文原名），按顺序检索正版商店，给每个结果打分，然后在页面右下角显示一张小卡片：商品名、价格、直达链接。

如果匹配不够可靠，它会明确显示**「暂未找到对应商品」**并给出搜索入口——**绝不会推荐一个看起来像的商品**。

**选择语言：** [English](README.md) · **简体中文** · [日本語](README.ja.md)

![Manifest V3](https://img.shields.io/badge/manifest-v3-blue)
![Chrome](https://img.shields.io/badge/Chrome-102%2B-4285F4)
![Tests](https://img.shields.io/badge/tests-143%20passing-2ea44f)
![Version](https://img.shields.io/badge/version-0.5.5-informational)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

> ### 适用范围与声明
>
> * 本工具面向 **成人（R18）内容**场景，**仅供成年人使用**。
> * 它**只读取公开页面**并**跳转到官方商店**：不代登录、不加购物车、不购买、不下载，也不绕过付费墙、DRM、验证码或年龄确认。
> * 它不判断页面是否合法，也不会把任何信息上报到哪里——所有处理都在你自己的机器上完成。
> * 商店名称与商标归各自所有者所有；本项目与 DLsite、FANZA（DMM）、Melonbooks 无任何关联。

---

## 目录

- [它做什么](#它做什么)
- [支持的页面类型](#支持的页面类型)
- [工作原理](#工作原理)
- [支持的商店](#支持的商店)
- [安装](#安装)
- [使用](#使用)
- [验证](#验证)
- [隐私与权限](#隐私与权限)
- [可调参数](#可调参数)
- [开发](#开发)
- [已知限制](#已知限制)
- [变更记录](#变更记录)
- [后续方向](#后续方向)
- [许可证](#许可证)

---

## 它做什么

* **读取当前页面**：`<title>`、`h1`–`h4`、`og:title`、JSON-LD、画廊信息块（`Tags / Groups / Languages / Pages`）以及正文采样。
* **提取并清洗作品名**：去掉网站名、广告语、章节号、`[DL版]` / `[Chinese]` 这类标签，并在日文原名、罗马音、译名之间**优先选择日文原名**（三家商店的商品名基本都是日文）。
* **按顺序检索正版商店**：DLsite → FANZA → Melonbooks，任何一家给出高可信度匹配就立即停止。
* **打分并分级**：`≥85` 判定为「找到正版」；`62–84` 判定为「可能的正版」（最多列 3 个候选）；`<62` **完全不展示**。
* **在页面上显示浮窗**（Shadow DOM，可收起 / 可关闭，不参与页面布局），同时提供 **Popup**：识别详情、设置、缓存管理。
* **能应对站内跳转**：对于不刷新页面就换内容的站点（部分画廊站属于这一类），有「换页闸门」——等新页面真正渲染出来再读取（这正是 v0.3.0 修复的问题，见[变更记录](#变更记录)）。
* **默认安静**：不像作品页的页面不显示卡片、不发任何请求。

### 结果显示的样子

页面右下角的浮窗：

```
┌────────────────────────────────┐
│ 📚 找到正版              –  ×  │
│                                │
│ 《示例作品名》                  │
│ [DLsite] 1,980円 约 87 元       │
│ 社团 / 作者                    │
│                                │
│ [ 查看正版 ]      [ 收起 ]      │
│ 是否购买由你自行决定。          │
└────────────────────────────────┘
```

Popup 里还能看到：识别出的作品名及其来源、各商店的独立结论（找到 / 未找到 / 需要年龄确认 / 查询失败）、匹配度，以及「在页面显示」「重新识别」按钮。

---

## 支持的页面类型

| 页面类型 | 例子 | 识别方式 |
| --- | --- | --- |
| 在线漫画阅读页 | `【作品名】第12話 - 免费漫画` | 标题里的章节标记 + 漫画关键词 + 正文采样 |
| 同人志画廊页 | 作品页上带有 `Tags / Groups / Languages / Pages` 这类信息字段的页面 | 信息块结构（≥2 个字段）+ 站点提示 + 多图 |
| 通用作品详情页 | 含 `/comic/…`、`/gallery/…`、`/read/…` 的 URL + 多图 + 漫画关键词 | URL 形状 + 图片数量 + 关键词组合 |

其它页面（博客、新闻、搜索引擎、视频与购物站等）一律跳过：不出卡片、不发请求。

---

## 工作原理

```
content script（页面里）                    service worker（后台）
──────────────────────────────────────    ─────────────────────────────────────────
读取 title / 各级标题 / og / JSON-LD  ──▶ 判断「这像不像作品页」
读取画廊信息块                             清洗标题 → 生成搜索变体
监听站内跳转                               DLsite → FANZA → Melonbooks
                                          解析结果、匹配、分级
渲染 Shadow DOM 卡片                 ◀──  产出一个状态对象（找到 / 可能 / 未找到）
```

1. **content script** 采集页面信息并上报后台（`src/content/extractor.js`）。
2. **站点判断** 决定这个页面值不值得分析（`src/lib/site-filter.js`）。
3. **清洗器** 把原始标题变成可搜索的作品名和若干变体（`src/lib/cleaner.js`）。
4. **商店适配器** 构造搜索 URL、抓取结果页并解析（`src/stores/`）——跨域请求只能由后台发起。
5. **匹配器** 用 4 种字符串相似度策略打分并分级（`src/matching/matcher.js`）。
6. 最终状态会渲染成卡片并按标签页缓存，Popup 读的是同一份状态。

chrome API 边界之上的部分都是纯函数，因此整条流水线可以在 Node 里对着 `src/stores/fixtures/` 的快照做单元测试。

---

## 支持的商店

| 商店 | 搜索入口 | 条目结构 | 备注 |
| --- | --- | --- | --- |
| **DLsite** | `https://www.dlsite.com/<section>/fsr/=/language/jp/keyword/<关键词>/` | `li[data-list_item_product_id]` + `dd.work_name` / `dd.work_price_wrap` | 关键词里的空格**必须**写成 `+`，写成 `%20` 会被 WAF 直接 403 |
| **FANZA**（DMM） | `https://www.dmm.co.jp/search/=/searchstr/<关键词>/` | `/-/detail/=/cid=d_XXXXXX/` + `p.text-sm.font-bold` + `770円` + `サークル：…` | 需要年龄确认 Cookie，见下 |
| **Melonbooks** | `https://www.melonbooks.co.jp/search/search.php?name=<关键词>&adult_check_flg=1` | `li.product_NNNNNNN` + `p.item-ttl.product_title` + `p.item-price` | 无需 Cookie |
| **Pixiv** | `https://www.pixiv.net/ajax/search/artworks/<关键词>?…&s_mode=s_tag`（JSON） | `body.illustManga.data[]` → `id` / `title` / `userName` / `xRestrict` | 复用你的 Pixiv 会话；**R-18 作品必须登录并确认年龄后才搜得到** |
| **Fantia** | `https://fantia.jp/api/v1/search/posts?q=<关键词>`（JSON） | `posts[]` → `id` / `title` / `fanclub.name` | 公开 JSON 接口；成人向内容可能需要年龄确认，因此会复用浏览器会话 |

### FANZA 与年龄确认

FANZA 的请求使用 `credentials: 'include'`，即**复用浏览器里已有的年龄确认状态**（`age_check_done=1`）。如果拿到的是年龄确认页，扩展**不会假装「没有结果」**，而是把该商店标为「需要年龄确认」，给出确认链接；确认完回来点「重新识别」即可。

只有 FANZA 的请求会带 Cookie；DLsite 与 Melonbooks 始终不带凭据。

---

## 安装

### 环境要求

* Chrome / Chromium **102 或更高版本**（Manifest V3 + ES module service worker）。Edge 同样可用。

### 用发布包安装

1. 下载并解压 `manga-dlsite-navigator-v0.5.5.zip`。
2. 打开 `chrome://extensions/`，打开右上角的**开发者模式**。
3. 点击**加载已解压的扩展程序**，选择包含 `manifest.json` 的那一层目录。

### 从源码安装

```bash
git clone https://github.com/<你的账号>/manga-legal-navigator.git
```

然后用「加载已解压的扩展程序」选中仓库目录即可——**没有构建步骤、没有打包器、没有依赖**。

可选：在扩展详情页打开「**允许访问文件网址**」，这样才能用 `tests/pages/` 里的本地测试页；访问正常网站不需要它。

---

## 使用

1. 打开任意漫画 / 同人志页面。识别到作品时，右下角会在一两秒内出现卡片。
2. 点击**查看正版**（或 Popup 里的同名按钮）在新标签页打开商品页。买不买由你决定。
3. 点击工具栏图标可以看详情：页面标题、识别出的作品、各商店结论、匹配度，以及设置项。
4. 如果结果看着不对，点**重新识别**；换了页面之后再打开 Popup，它也会自动按新页面重新检查。

### Popup 设置

| 设置 | 默认 | 含义 |
| --- | --- | --- |
| 启用插件 | 开 | 总开关。关掉后不读取页面、不发请求、不显示卡片。 |
| 识别到作品时自动在页面显示浮窗 | 开 | 关掉后结果只出现在 Popup 里，或点「在页面显示」才出卡片。 |
| 用作者 / 社团名兜底搜索 | 开 | 额外用页面上的作者 / 社团名再搜一轮。部分站点（尤其 Pixiv）会把作品换成别的标题存放，只搜标题会漏掉。 |
| 人民币估算汇率（1 日元 = ? 元） | 空（用内置 0.044） | FANZA / Melonbooks 不提供人民币价格，用这里的汇率换算成「约 X 元」。留空就用内置值（Google Finance 2026-09-12 07:54，1 JPY = 0.0437 → 0.044）；DLsite 商品用商店自己给的换算，不走这里。改完会立即生效，不需要清缓存。 |
| 使用离线示例数据（调试用） | 关 | 用 `src/stores/fixtures/` 里的示例快照跑完整流水线，不发网络请求。 |
| 跳过「是否漫画页」判断（调试用） | 关 | 所有页面都分析，开发新商店适配器时很有用。 |

Popup 里还会显示当前缓存了多少条搜索结果，并提供**清除搜索缓存**按钮。

---

## 验证

2026-09-11 在 Chrome 上对着真实的同人志画廊页面与三家商店手工验证：

| 验证项 | 结果 |
| --- | --- |
| 画廊页标题提取（日文原名在次级标题里、旁边还有一个罗马音/英文标题） | 用日文原名去搜索 |
| DLsite 上确实有售的作品（含打折商品） | 商品名、现价、原价、折扣标签都能正确读出 |
| DLsite 没有、但 **FANZA 有**的作品 | 显示 FANZA 的结果，DLsite 一行如实写「未找到」 |
| Melonbooks 有售的作品 | 显示 Melonbooks 的结果与价格 |
| 三家商店都没有的作品 | 正确显示「暂未找到」，不会推荐错误商品 |
| 站内跳转：点进作品页后 **100 毫秒内**打开 Popup | 显示新页面的作品，绝不会显示上一页的标题 |

> **文档约定**：本仓库**不包含任何真实作品名、商品 ID 与商店链接**——文档、测试、快照里都是占位数据（`サンプル作品アルファ`、`RJ00000000` 之类）。商店列表属于第三方内容，运行时只在你自己机器上读取。想复现验证，打开你在意的作品页，把卡片和商店本身的搜索结果对照一下即可。

---

## 隐私与权限

* 没有账号体系、没有统计埋点、没有分析服务、没有任何自建服务器。
* 只读取**公开页面信息**（标题、各级标题、`og:`/JSON-LD、画廊信息块、正文采样），并且**只向上面三家商店**发起搜索请求。
* 缓存保存在本机 `chrome.storage.local`；缓存键是搜索关键词的散列，**不记录你访问过哪些网页**，Popup 可一键清除。

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存设置与搜索结果缓存 |
| `activeTab` | Popup 读取当前标签页，用于展示状态与手动重新识别 |
| `host_permissions`：`dlsite.com`、`dmm.co.jp`、`melonbooks.co.jp` | 抓取三家商店的公开搜索页；content script 受 CORS 限制，必须由后台发起 |
| content script 匹配 `http/https/file` | 读取你正在看的页面。安装时 Chrome 会提示「读取和更改您在所有网站上的数据」——任何读取页面标题的扩展都会有这条提示。 |

**明确不做**：登录任何商店、处理密码、提交表单、自动购买或下载、绕过访问限制 / DRM / 验证码 / 年龄确认。

---

## 可调参数

阈值与时间参数都在 [`src/lib/config.js`](src/lib/config.js)：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `matcher.high` | 85 | 达到该分数才显示「找到正版」 |
| `matcher.possible` | 62 | 达到该分数显示为「可能的正版」 |
| `matcher.minCandidate` | 50 | 低于该分数的候选一律不展示 |
| `matcher.tieMargin` | 6 | 第二名与第一名差距小于该值时，改为列候选而不是武断选一个 |
| `cache.positiveTtlMs` | 30 分钟 | 命中结果的缓存时长 |
| `cache.negativeTtlMs` | 5 分钟 | 「没有找到」的缓存时长（短一些，新上架的作品能更快出现） |
| `search.minIntervalMs` | 900 毫秒 | 对商店请求的最小间隔（不给人添麻烦） |
| `search.timeoutMs` | 12 秒 | 单次请求超时 |
| `extractor.urlPollMs` | 900 毫秒 | content script 检测地址变化的轮询间隔 |
| `extractor.settleQuietMs` / `settleMaxWaitMs` | 400 毫秒 / 5 秒 | 换页闸门：DOM 需要静止多久算换好，以及最长等待时间 |

---

## 开发

### 目录结构

```
manga-legal-navigator/
├── manifest.json                  # MV3：最小权限 + 三家商店域名
├── package.json                   # 只是为了让 Node 以 ESM 运行测试
├── icons/                         # 16 / 32 / 48 / 128 图标
├── src/
│   ├── content/
│   │   ├── extractor.js           # 读取页面信息（title / 标题 / og / JSON-LD / 采样）
│   │   ├── ui.js                  # Shadow DOM 卡片（找到 / 可能 / 未找到 / 错误）
│   │   └── content.js             # 流程编排 + 站内跳转闸门
│   ├── background/
│   │   └── service-worker.js      # 唯一的网络出口；每标签页状态；角标
│   ├── stores/
│   │   ├── store-adapter.js       # StoreAdapter 抽象（searchPlan / searchStep / parseResults）
│   │   ├── dlsite.js              # DLsite 适配器
│   │   ├── fanza.js               # FANZA 适配器（复用 Cookie + 年龄确认处理）
│   │   ├── melonbooks.js          # Melonbooks 适配器
│   │   ├── registry.js            # 商店注册表（加新商店改这里）
│   │   └── fixtures/              # 示例快照（DOM 与真实页面一致，数据是占位数据）
│   ├── matching/matcher.js        # 相似度打分与分级
│   ├── lib/                       # config、文本工具、清洗器、站点判断、流水线、缓存、设置
│   ├── qa/                        # 真实环境 QA：结构指纹、捕获记录、导出与脱敏
│   ├── shared/protocol.js         # 消息类型与状态枚举
│   └── popup/                     # popup.html / popup.js / popup.css
├── tests/                         # Node 测试 + 6 个本地测试页
│   └── real-world/                # 真实环境测试集（按结构分类，只有结构 + 预期）
├── tools/probe-store.mjs          # 联网探针（--store dlsite|fanza|melonbooks|pixiv|fantia）
├── tools/probe-dlsite.mjs         # 旧入口，转发到 probe-store --store dlsite
├── tools/qa-*.mjs                 # QA：重放测试集 / 汇总报告 / 导入案例
├── docs/QA.zh-CN.md               # Real-world QA 操作手册（需求书 v0.1）
└── docs/DEVELOPMENT.zh-CN.md      # 完整的中文开发与实测笔记
```

### 测试

```bash
node --test tests/*.test.js      # 183 项，全部离线
npm test                         # 同上
node tools/lint-anonymity.mjs    # 检查仓库里是否混进了真实商品号 / 画廊号
node tools/qa-run.mjs            # 离线重放 tests/real-world/ 全部真实案例
```

覆盖范围：标题清洗（含「不该被过度清洗」的反例）、匹配阈值、站点判断、商店解析（HTML 快照）、端到端流水线、卡片模板、Popup，以及站内跳转闸门（`tests/content-nav.test.js`）。

### 联网探针

```bash
node tools/probe-store.mjs --store dlsite "サンプル作品名"
node tools/probe-store.mjs --all "キーワード" --json          # 逐家商店体检
node tools/probe-store.mjs --title "【サンプル作品】第3話 - 免费漫画 - 示例漫画网"
node tools/probe-store.mjs --store fanza "キーワード" --raw    # 打印片段，用于重新校准选择器
node tools/probe-dlsite.mjs "キーワード"                       # 旧入口，等价于 --store dlsite
```

探针会打印搜索 URL、HTTP 状态、解析到的条目数、**适配器健康度**
（healthy / degraded / blocked / parser-broken / search-failed / no-result）和前几名候选及其分数——
商店改版时，一眼就能看出是 URL 失效、被拦截，还是选择器失效。
注意：HTTP 200 但解析到 0 条会被报成 `parser-broken`，绝不会被当成「这部作品不存在」。

### 本地测试页（需求文档测试 A–F）

`tests/pages/` 下有 6 个可用 `file://` 打开的页面，每页顶部都写了期望结果：

| 测试 | 文件 | 期望 |
| --- | --- | --- |
| A | `test-a.html` | 标题 + 章节号 → 章节号被剥掉，用剩下的作品名去搜索 |
| B | `test-b.html` | 带 【】、章节号、网站名的标题 → 三者都被清洗掉 |
| C | `test-c.html` | 不存在的作品 → 「暂未找到」+ 搜索入口，**不显示任何商品** |
| D | `test-d.html` | 与 A/B 相同的清洗路径，并说明怎么复现「候选列表」场景 |
| E | `test-e.html` | 成人向作品 → 与全年龄作品流程完全一致 |
| F | `test-f.html` | 编程博客 → **完全不出现浮窗**，不推荐任何商品 |

这些页面用的是**示例作品名**（不含任何真实作品名称，也不是由真实作品改写而来），所以去商店搜不到——卡片显示「暂未找到」就是预期结果。想看真实命中，把其中一个页面的 `<title>` / `og:title` / `h1` 换成你自己在意的作品名再刷新即可。

### 测试快照

`src/stores/fixtures/*.html` 是**手写的“示例快照”**：DOM 结构、类名、属性与真实页面一致（解析器就是照着这些写的），但商品名、商品 ID、社团名、图片地址全部是占位数据。它们的作用是让商店解析器能离线回归。

想拿**真实**页面校对解析器时，把抓下来的 HTML 放到 `src/stores/fixtures/local/` —— 这个目录已被 gitignore，真实商品数据不会进仓库。

### 真实环境 QA（Real-world QA）

需求书 v0.1 的 QA / Site Discovery 阶段，工具已经全部就位，完整说明见
[`docs/QA.zh-CN.md`](docs/QA.zh-CN.md)。

```text
Popup [QA Capture] 打开      →  正常浏览测试页面
        ↓ 每次分析后写一条结构化记录（几 KB，不含 HTML）
Popup [PASS / FAIL / LIMITATION / 误判]  →  值得保留的页面 [Create Test Case]
        ↓
[Export Summary] / [Export Failed Cases] / [Export Test Case Pack]
        ↓ 放进 qa/inbox/
node tools/qa-report.mjs     →  qa/qa-summary.json + qa/failures/FAIL-xxx.json
node tools/qa-import.mjs     →  tests/real-world/<分类>/RW-xxx.json（进仓库，匿名）
                                tests/sites.local.json + qa/captures/（不进仓库）
node tools/qa-run.mjs        →  离线重放，验证可重复执行
```

设计要点：

* QA Capture **默认关闭**，普通用户不产生数据、不增加请求、看不到面板（§34）。
* 只记录**结构化特征 + 插件处理结果**，不保存完整 HTML、图片、Cookie、正文（§7）。
* 导出默认**脱敏**：真实标题 / 商品 ID / URL 换成占位符，只保留长度、文字系统与短哈希；
  需要真实数据时必须显式勾选，并且只能落到 git-ignored 的 `qa/`、`tests/sites.local.json`（§9）。
* 每次测试的导出只有几 KB，本地脚本先统计，**只有失败案例**才交给 Codex（§8、§26）。
* 每个页面都有一个结构指纹（如 `G-H1-OG-NJ-IMG40-INFO-SPA`）和 Novelty Score，
  用来判断这个页面是否代表一种新结构（§10–§12）。

`tests/real-world/` 里已经有 13 个可直接重放的占位案例（其中 1 个已知清洗缺陷、
1 个已知限制），第一批约 40 个真实案例的配额与现状见 `docs/QA.zh-CN.md` 第 8 节。

### 打包发布

```bash
# 在仓库根目录执行；压缩包输出到已被 gitignore 的 outputs/
zip -qr outputs/manga-dlsite-navigator-v0.5.5.zip . \
  -x ".git/*" ".DS_Store" "*/.DS_Store" "*/node_modules/*" "*.local.*" "*/fixtures/local/*" \
     "outputs/*" "*.zip" "qa/*" "tests/sites.local.json"
```

`*.local.*`、`*/fixtures/local/*`、`qa/*`、`tests/sites.local.json` 这几条排除项不能删：
它们装的是本机专用文件（真实作品名、手工保存的页面快照、QA 捕获与汇总），一律不能外流；
之前就是因为排除项写得太窄，其中一个混进了压缩包。

---

## 已知限制

1. **译名匹配不到**：商店索引以日文商品名为主。页面上只有中文或英文译名时，只能显示「暂未找到」+ 手动搜索入口。
2. **商店确实没有该作品**：多数商业出版社作品（集英社、讲谈社等）不在 DLsite / FANZA / Melonbooks 上，「暂未找到」就是正确答案。
3. **过短标题**：少于 3 个字符的关键词在 DLsite 上固定返回 0 结果，此时会退化为手动搜索入口。
4. **匹配偏保守**：低于 62 分一律不展示，所以「只是别的商品名的一部分」的查询会显示「暂未找到」，而不是一个看起来很像的错误商品。
5. **特殊标题格式**：网站名与作品名之间没有任何分隔符时可能清洗不干净——结果依然是「暂未找到」，不会瞎猜。
6. **商店改版**：解析基于实测 HTML，并有快照测试兜底；万一改版，适配器会报「查询失败」或 `parser-broken`，而不是静默地当作「没有结果」。用 `tools/probe-store.mjs`（或旧的 `probe-dlsite.mjs`）重新校准即可。
7. **网络环境**：部分网络无法访问这些商店，此时会提示查询失败；插件限制 900 毫秒最小间隔、缓存 30 分钟，不会给商店造成压力。
8. **站内跳转**：通过 `pushState` 钩子 + 0.9 秒地址轮询发现换页，然后等 DOM 静止（400 毫秒，最多 5 秒）。极少数换页很慢的站点可能先用旧内容识别一次，换好后会自动重新识别，也可以在 Popup 点「重新识别」。
9. **方括号里的社团名**：标题形如 `[社团名 (作者)] 作品名` 时，第一个搜索变体保留方括号写法，第二个变体去掉它。
10. **浏览器**：优先 Chrome / Chromium；Edge 应该可用；Firefox 需要 `browser.*` shim 并调整 manifest。
11. **章节收录在杂志里**：有些同人作品是刊登在杂志上的，商店只卖**那一期杂志**（`…号 …`），而画廊页写的是章节名。两者没有共同文字，因此插件会显示「暂未找到」；搜索入口能跳到那一期杂志，但要自动匹配就等于推荐一个无法验证的商品。
12. **Pixiv 的 R-18 需要你的会话**：Pixiv 只对「已登录 + 已确认年龄」的会话返回成人作品（实测：匿名搜索一个热门成人标签，总数不变但返回的全是全年龄条目）。因此插件对 Pixiv 的请求会带上你的 Cookie；搜索为空时会在 Popup 里说明原因，而不是断言「这部作品不存在」。另外 Pixiv 上的标题常与同人志标题不同，可能搜不到实际存在的作品。

---

## 变更记录

**未发布（Real-world QA 阶段，需求书 v0.1）**

* **新增 QA Capture 模式**（Popup 最下方，默认关闭）：正常浏览页面即自动记录结构化页面摘要
  （页面类型、结构指纹、标题元素、og / JSON-LD、图片数、信息块字段、SPA、提取与清洗结果、
  商店状态、请求数、缓存命中、匹配分数）。不保存完整 HTML、图片、Cookie 或正文。
* **结构指纹与新颖度**：`G-H1-OG-NJ-IMG40-INFO-SPA` 这样的短指纹 + Novelty Score，
  用来判断「这个页面是否代表一种新的结构」，并自动分类到 `tests/real-world/` 的目录。
* **测试结果记录**：Page recognition / Title extraction / Cleaning / Store search /
  Correct match / False positive / False negative / Navigation / Request count / Cache behavior，
  取值 `PASS` / `FAIL` / `EXPECTED_LIMITATION` / `NOT_TESTED`。
* **本地 QA 数据闭环**：`[Create Test Case]` → `RW-nnn`；`[Export Summary] / [Export Failed Cases] /
  [Export Test Case Pack]` 三个导出默认脱敏（占位符 + 短哈希），真实数据只能落到 git-ignored 路径。
* **新增工具**：`tools/qa-run.mjs`（离线重放 `tests/real-world/`）、`tools/qa-report.mjs`
  （汇总成 `qa/qa-summary.json` + `qa/failures/FAIL-xxx.json`）、`tools/qa-import.mjs`
  （拆分为仓库案例 + 本地 URL / 页面摘要）。
* **探针泛化**：`tools/probe-store.mjs` 支持 `--store dlsite|fanza|melonbooks|pixiv|fantia`、`--all`、
  `--json`，并输出适配器健康度（healthy / degraded / blocked / parser-broken / search-failed / no-result）；
  `tools/probe-dlsite.mjs` 保留为兼容入口。
* **第一批 13 个占位测试案例**已提交（结构 + 预期，可离线重放），阶段目标约 40 个；
  本阶段只记录问题，不改匹配算法。
* **人民币估算汇率集中管理**：FANZA / Melonbooks 原来各自写死 `0.044` / `0.05`，
  现在统一读 `CONFIG.currency.jpyToCny`（默认 **0.044**，来源 Google Finance
  2026-09-12 07:54：1 JPY = 0.0437 CNY 四舍五入），并可在 Popup 设置里自行录入；
  DLsite 仍然优先使用商店自己给出的人民币价格。换算挪到「生成卡片」阶段，
  改汇率立即生效、无需清缓存，免费商品也不会再显示「约 1 元」。

**0.5.5**

* **打包命令修正。** 文档里的 `zip` 改为在仓库根目录执行，排除项补上 `*.local.*` 与 `*/fixtures/local/*`。此前的模式太窄，把 `docs/forbidden-names.local.txt`（本机真实作品名清单，供检查脚本使用）打进了发布包。
* `tools/lint-anonymity.mjs` 在路径含空格时不再静默退出：入口判断改用 `pathToFileURL()` 生成 URL 比对，不再拼字符串。修复前它什么都不扫，却仍然报「通过」。
* 安装说明改成当前版本的压缩包名；打包命令不再依赖仓库文件夹名。

**0.5.4**

* 按钮现在跟着「这家店有没有结果」走：**有命中的商店高亮并前移**（DLsite 优先，其余按配置顺序），没命中的保持灰按钮排在后面；如果全都没命中，则改为**作者入口高亮**（它是此时唯一还有用的动作）。
* Pixiv 作者链接改用站点自己的参数：`/search/users?nick=<名字>&s_mode=s_usr`（之前的 `?word=` 形式一个人也搜不到）。
* 作者名优先取**日文**——日文标题方括号里的写法（`[らーめん] …`）；因为信息块里的 `Artists` / `Groups` 字段是罗马音 slug（`ra-men 171`），拿它搜日本站点搜不到人。

**0.3.1**

* 商店搜索关键词不再带标点和「出处注释」。
  * 实测（2026-09）：关键词里带标点（例如 `サンプル！作品 第2巻`）时 Melonbooks 返回 **0 条**，换成空格分隔的形式就能搜到商品——标点会静默让搜索失败。发给商店的关键词现在会把标点替换成空格；展示给用户的标题仍保留原样，匹配打分也不受影响（匹配器本来就会去掉标点）。
  * 结尾那种「说出处 / 规格」的括号（杂志号 `(サンプルマガジン Vol.54)`、页数 `(…ページ)`、活动号 `(C…)`）现在会在剥离卷号**之前**先去括号。以前先剥 `Vol.54` 会留下一个 `(名称 )` 的空壳括号，关键词因此搜不到任何东西。
  * 已用你报的页面验证：其中两部现在能在 Melonbooks 命中（匹配度 100）；第三部的商店搜索入口能找到登载它的那一期杂志（插件仍显示「暂未找到」，见已知限制 11）。

**0.3.0**

* 修复「点开新页面后偶尔不读取信息」——Popup 可能显示**上一个**页面的作品。表面现象是把画廊站**首页的标语**当成了作品名，并显示「暂未找到对应商品」。
  * 根因：这类站点点链接是**站内跳转**（地址变了、页面没重新加载、content script 也没重建）。在这段窗口里，地址已经指向新作品，DOM 还是旧页面。
  * content script 增加**换页闸门**：`pushState` / `popstate` / 地址轮询任一发现变化后，等 DOM 真的换好（静止 400 毫秒，最长 5 秒）再读取。
  * 换页期间，页面信息请求会等新内容就绪再回答，不会再拿旧内容应付；旧卡片同时立即移除。
  * 新增 `settled` 信号：`og:url` / `canonical` 与地址栏不一致时，按「还没换好」处理，绝不拿去搜索。
  * 状态里记录产生它的文档编号（`page.scriptId`）：只有同一份文档才复用缓存；后台也只在标签页仍停在原地址时才写入状态。
* 已按上表在真机验证，回归测试 142 项。

**0.2.2** — 站点根路径 / 列表页不再分析；导航栏文案不再被当成「作品页」信号。

**0.2.1** — Popup 会丢弃属于其它页面的缓存状态；同一标签页的进行中分析会去重。

**0.2.0** — 新增 **FANZA** 与 **Melonbooks** 适配器（DLsite → FANZA → Melonbooks，命中高可信度即停止）、FANZA 年龄确认复用浏览器 Cookie、Popup 逐店显示结论。

**0.1.x** — 标题提取与清洗（日语优先、去掉译名标签与章节号）、页面浮窗、Popup、DLsite 适配器与离线快照测试。

---

## 后续方向

* 更多商店（BookWalker、Amazon、Kobo…）：实现 `src/stores/store-adapter.js` 并在 `registry.js` 注册即可。
* 用作者 / 社团、ISBN 辅助匹配，提升召回率。
* 改进「网站名和作品名连在一起」的清洗。
* 可选的中日文译名反查，让译名也能命中。
* Firefox 版本。

---

## 许可证

本项目使用 **MIT 许可证**，全文见 [LICENSE](LICENSE)。

简单说：你可以自由使用、复制、修改、合并、发布、分发、再授权甚至出售这份代码，只要保留版权声明和许可证文本。

---

## 说明

本工具最初只是「边看边找正版」的个人需求。仓库里记录的商店 URL、HTML 结构与行为都是 2026 年 9 月手工实测的结果；商店改版后请重新跑探针校准。
