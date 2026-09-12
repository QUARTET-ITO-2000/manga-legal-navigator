# 真实环境 QA 与站点发现（Real-world QA）

对应需求书 **v0.1** 的 §1–§37。本文是该阶段的操作手册：工具在哪、怎么跑、
数据放在哪、哪些文件不能进 Git，以及第一阶段已经记录下来的问题。

## 1. 阶段目标与纪律

目标不是「支持更多网站」，而是建立一套**低成本发现真实网页兼容性问题**的体系：

```text
用户正常浏览测试页面
        ↓  QA Capture（浏览器侧，结构化摘要）
        ↓  生成很小的结构化数据（几 KB，不含 HTML）
        ↓  本地脚本统计（tools/qa-report.mjs）
        ↓  只把失败案例交给 Codex
        ↓  Codex 分析 → 集中修复 → 回归
```

第一阶段（当前）**只做三件事**：分析、建立测试工具、建立测试计划。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 分析 + 测试工具 + 测试计划（不改匹配算法） | ✅ 已完成 |
| 2 | 用真实页面执行测试 | ▶ 接下来 |
| 3 | 整理 Bug / Expected Limitation / Feature Request | |
| 4 | 集中修复 | |
| 5 | 重跑全部自动测试 + Real-world regression | |

「测试优先于修改」：发现的问题先按类别记录
（Extraction / Cleaning / Site Filter / Store Adapter / Matching / Cache /
Navigation / Performance / Expected Limitation / Test Data），
第 4 阶段才集中决定怎么修。本仓库当前记录的已知问题见第 10 节。

## 2. 工具总览

| 位置 | 作用 |
| --- | --- |
| `src/qa/fingerprint.js` | 页面结构特征、指纹（`G-H1-OG-NJ-IMG40-INFO-SPA`）、新颖度评分、分类 |
| `src/qa/record.js` | QA Capture 记录、测试结果表（§14）、汇总统计（§27） |
| `src/qa/export.js` | 三种导出（summary / failures / tests）与脱敏（§8、§9、§28） |
| `src/qa/storage.js` | 本地生命周期（chrome.storage.local、导出序号、清空）（§32、§33） |
| `src/lib/store-health.js` | 商店健康度：healthy / degraded / blocked / parser-broken / search-failed / no-result（§30） |
| Popup「QA（真实环境测试）」面板 | 开关、计数、判定、Create Test Case、三种导出、Clear（§5、§32） |
| `tools/probe-store.mjs` | 联网探针：`--store dlsite\|fanza\|melonbooks\|pixiv\|fantia`、`--all`、`--json`（§29） |
| `tools/probe-dlsite.mjs` | 旧入口，现在转发到 `probe-store --store dlsite`，参数与输出保持兼容 |
| `tools/qa-report.mjs` | 把导出的 JSON 合并成 `qa/qa-summary.json` + `qa/failures/FAIL-xxx.json`（§27、§28） |
| `tools/qa-import.mjs` | 把 Test Case Pack 拆成仓库里的案例文件 + 本地 URL / 页面摘要（§13） |
| `tools/qa-run.mjs` | 离线/联网重放全部真实案例，输出 `qa/results-latest.json`（§14、§22、§24） |
| `tests/real-world/` | 按 §16 分类的测试集（第一批 13 个占位案例已提交） |

QA 相关命令：

```bash
npm run qa:run        # = node tools/qa-run.mjs       离线重放（不发网络请求）
npm run qa:report     # = node tools/qa-report.mjs    汇总导出 → qa/qa-summary.json
npm run qa:import     # = node tools/qa-import.mjs    导入 Test Case Pack
npm run probe         # = node tools/probe-store.mjs  联网探针
npm run lint:anon     # 提交前检查有没有真实商品号 / 作品名混进仓库
```

## 3. 怎么跑一轮真实测试

1. **打开 QA Capture**：Popup 最下方的「QA（真实环境测试）」→ 勾选
   「启用 QA Capture」。默认关闭，普通用户不会看到面板内容、也不会产生任何记录
   （§34）。打开时 Popup 会顺带重新识别当前页面，于是当前页也会被捕获一次。
2. **正常浏览测试页面**：像平时一样打开网址、点进作品页、点下一页。
   插件在每次分析结束后自动写入一条结构化记录。
3. **逐个页面判定**（可选但推荐）：

   ```text
   PASS                 结果符合预期
   FAIL                 结果不符合预期
   LIMITATION           知道做不到，暂时接受（例如商店本身没有）
   清除判定             回到未判定
   误判                 插件推荐了错误的商品（§15.5，最重要的一项）
   ```

4. **值得保留的页面点 `[Create Test Case]`**：分配 `RW-001` 这样的编号并记录
   结构特征与预期（§13）。
5. **导出**（三个按钮，都是本地下载，不会上传）：

   | 按钮 | 文件名示例 | 内容 | 默认是否含真实数据 |
   | --- | --- | --- | --- |
   | Export Summary | `qa-summary-2026-09-12-001.json` | 统计数字、结构分布、案例与失败索引（约 2 KB） | ❌ 永远不含 |
   | Export Failed Cases | `qa-failures-2026-09-12-001.json` | 每个失败一个 bundle（§28） | ❌ 占位符 |
   | Export Test Case Pack | `qa-tests-2026-09-12-001.json` | 案例 + 可重放页面摘要 + 真实 URL | 勾选后才含 |

6. **把导出的文件放进 `qa/inbox/`，然后本地汇总**：

   ```bash
   node tools/qa-report.mjs        # 读 qa/inbox/ 与 qa/
   node tools/qa-import.mjs        # 需要新增/更新测试案例时
   node tools/qa-run.mjs           # 重放全部案例，验证是否可重复
   ```

   `qa-run.mjs` 在有案例 FAIL 时以非 0 退出（方便接 CI），
   已知失败 / 已知限制会在输出里点名（当前是 RW-004 / RW-007）。

7. **只把 `qa/qa-summary.json` 和失败案例交给 Codex**（§26）。正常案例不要逐个发。

## 4. 记录了什么、没记录什么

每条 Capture 记录（§6）：

```json
{
  "id": "QA-0007",
  "capturedAt": 1757600000000,
  "origin": "https://example.test",
  "urlPattern": "/g/:id/",
  "pageType": "gallery",
  "fingerprint": "G-H1-OG-NJ-IMG40-INFO-SPA",
  "features": { "h1": true, "ogTitle": true, "jsonLd": false, "galleryInfo": true,
                "manyImages": true, "spaNavigation": true, "pageType": "gallery" },
  "novelty": { "score": 62, "verdict": "clearly-new", "similarTo": [] },
  "page": { "title": "…", "headings": ["…"], "imageCount": 46, "infoFieldCount": 5,
            "navigationType": "spa", "analysisCount": 2 },
  "extract": { "cleanedTitle": "…", "workKey": "3f9a1c07", "titleSource": "title",
               "variants": ["…"], "confidence": "high" },
  "stores": { "order": ["dlsite", "fanza"], "results": { "dlsite": "found", "fanza": "not_found" },
              "health": { "dlsite": "healthy" }, "fromCache": { "dlsite": false } },
  "requests": { "total": 2, "byStore": { "dlsite": 1, "fanza": 1 },
                "observations": [{ "requests": 2, "cacheHit": false }] },
  "match": { "grade": "found", "score": 100, "storeId": "dlsite", "productKey": "9c1b7e40" },
  "results": { "pageRecognition": "PASS", "titleExtraction": "PASS", "storeSearch": "PASS",
               "correctMatch": "NOT_TESTED", "falsePositive": "NOT_TESTED", "navigation": "PASS",
               "requestCount": "PASS", "cacheBehavior": "NOT_TESTED" },
  "verdict": "PASS",
  "pageInfo": { "…": "离线重放用的结构化页面摘要（截断后仍不含 HTML）" }
}
```

**默认不保存**（§7）：完整 HTML、DOM、图片、漫画页面、Cookie、登录信息、
页面正文、锚点列表。`pageInfo` 只是提取器已经读出来的结构化字段
（正文采样截断到 400 字符、信息块截断到 600 字符）。

**导出时的脱敏**（§9）：摘要永远不含真实数据；失败包 / 案例包默认把
标题、商品 ID、URL 换成 `<title-1>` / `<id-2>` / `<url-3>`，同时在
`placeholderDictionary` 里保留长度、文字系统、主机名与路径形状，
并用 8 位短哈希（`workKey` / `productKey`）让你能在本地把同一条记录串起来。

想保留真实标题（只在本地用）必须**显式勾选**「导出时包含真实标题 / URL」，
导出的文件会标记 `containsRealData: true`，此时必须保存到 git-ignored 的位置
（`qa/`、`tests/sites.local.json`、`*.local.json`）。

## 5. 文件与目录约定

```text
tests/real-world/            # 进仓库：只有结构 + 预期（§13、§16）
├── extraction/  cleaning/  matching/  navigation/  store/  performance/  negative/
├── RW-001.json …
qa/                          # 不进仓库（.gitignore）
├── inbox/                   # 从浏览器下载的导出文件放这里
├── captures/RW-001.json     # 可重放的页面摘要（真实数据）
├── failures/FAIL-017.json   # 每个失败一个包（§28）
├── qa-summary.json          # 本地汇总（Codex 的第一个入口）
└── results-latest.json      # tools/qa-run.mjs 的最近一次结果
tests/sites.local.json       # 不进仓库：真实测试页 URL（§13）
```

`tools/lint-anonymity.mjs` 会扫描「会进仓库的文件」，所以上述 git-ignored
路径即使含真实数据也不会被拦下来——反过来也说明：**不要**把真实数据写进
`tests/real-world/` 里的案例文件。

## 6. 指标定义（§15、§23、§24）

| 指标 | 计算方式 | 目标 |
| --- | --- | --- |
| Page recognition rate | `results.pageRecognition === PASS` 的捕获数 / 捕获总数 | 高 |
| Match precision | 判过「误判与否」的命中中，没有被标成误判的比例 | 高（§15.4 最重要） |
| False positive | `match.falsePositive === true` 的数量，或 grade 与预期不符 | **尽可能接近 0** |
| False negative | `results.falseNegative === FAIL` 的数量 | 允许，但要写原因 |
| Request budget | 每次分析的商店请求数（分商店）+ 超预算数量；非作品页必须是 0 | 越小越好 |
| Cache behavior | 同一页面第二次分析请求数必须为 0（`cacheBehavior`） | 必须 PASS |
| Novelty score | 与已有结构的最相似度 → 0–20 重复 / 21–50 少量新特征 / 51–80 明显新 / 81–100 新类型 | 用来判断是否值得加入测试集 |

哪些捕获会被算成「失败案例」（`qa/failures/FAIL-xxx.json`）：

* 人工标了 **误判** 或判定为 **FAIL**；
* 页面**被识别为作品页**，但自动检查里有一项 FAIL
  （标题提取 / 清洗 / 商店搜索 / 请求预算 / 导航 / 缓存）；
* 页面**不是作品页**，却仍然发了商店请求（违反 §21 / §23）。

负向测试里「页面没被识别」本身是**预期结果**，所以不会被当成失败——
它只作为测量结果留在 `results.pageRecognition` 里（`FAIL` 表示没识别出来）。

## 7. 商店健康度（§29、§30）

```bash
node tools/probe-store.mjs --store dlsite "サンプル作品名"
node tools/probe-store.mjs --store fanza --title "【サンプル作品】第3話 - 免费漫画"
node tools/probe-store.mjs --all "キーワード" --json
node tools/probe-dlsite.mjs "キーワード" --raw     # 旧入口，等价于 --store dlsite
```

输出是紧凑摘要（默认不打印 HTML）：

```text
Store: DLsite (dlsite)
  [primary] HTTP: 200  Parsed: 24  reason=ok
HTTP: 200
Parsed: 24
Health: healthy — Healthy — search returned candidates
Top candidates:
1. サンプル作品アルファ  score=100  1,980円
```

判定规则（`src/lib/store-health.js`）：

| 健康度 | 触发条件 |
| --- | --- |
| `healthy` | 搜索成功并有条目 |
| `degraded` | 有条目，但计划里的某一步失败 |
| `blocked` | 401/403/429/451/503，或 age-check / login-required / blocked |
| `parser-broken` | HTTP 200 但没有条目、也没有「未找到」标记（选择器该更新了） |
| `search-failed` | 空响应 / 不是搜索页 / 超时 / 5xx |
| `no-result` | 商店明确给出「未找到」标记 |

> **HTTP 200 + 解析到 0 条** 会被报成 `parser-broken`，绝不会被当成
> 「这部作品不存在」。测试案例里的 `health` 字段也是按这套规则断言的。

## 8. 测试集现状（§16、§17、§18–§22）

`tests/real-world/` 已提交 13 个**占位数据**案例（结构与真实页面一致，标题 /
URL / 商品都是示例值），可以直接离线重放：

| ID | 分类目录 | 覆盖点 | 结果 |
| --- | --- | --- | --- |
| RW-001 | extraction | 标准作品页：H1 + og:title + 信息块 + 40 图 | PASS |
| RW-002 | extraction | 没有 H1 的 Reader：og:title + JSON-LD + 话数 | PASS |
| RW-003 | cleaning | 【作品名】第12話 EP12 + 站点名 | PASS |
| RW-004 | cleaning | `[站点名] 作品 第2話 - Online Reader` | **FAIL（已知清洗缺陷）** |
| RW-005 | matching | 第2部 页面必须命中第2部（不能被第1部抢走） | PASS |
| RW-006 | matching | 総集編 只能是 possible，不能是 found | PASS |
| RW-007 | matching | 一字之差的「不存在的作品」会不会被推荐 | EXPECTED_LIMITATION |
| RW-008 | navigation | SPA 后的 Reader：标题重识别、请求仍为 1 | PASS |
| RW-009 | navigation | 连跳两次后的 Gallery：第二次命中缓存 | PASS |
| RW-010 | store | DLsite 没有 → FANZA 命中，且不再查 Melonbooks | PASS |
| RW-011 | performance | 商店全都没有时的一次分析请求数（实测 7，预算 8） | PASS |
| RW-012 | negative | 普通博客：0 请求、不推荐 | PASS |
| RW-013 | negative | 站点搜索页：0 请求 | PASS |

第一批的扩充配额（§17，总计约 40 个）：

```text
10  标准页面           ← 目前 2 个
10  标题异常页面        ← 目前 2 个
 5  相似作品/易误匹配    ← 目前 3 个
 5  应该找不到的页面     ← 目前 1 个（RW-011）
 5  SPA / 动态页面      ← 目前 2 个
 5  特殊结构页面        ← 目前 3 个（无 H1 / 少元数据 / 列表页）
```

已经覆盖了足够多的结构就别再为数字加案例（§17）。

## 9. Token 效率（§25、§26）

* 浏览器只产出结构化 JSON（每次测试几 KB，而不是几十 MB 的 HTML）。
* `tools/qa-report.mjs` 只打印 10 行左右的汇总 + 失败清单，**不打印标题**。
* Codex 的第一步永远是 `qa/qa-summary.json`：

  ```json
  { "summary": { "total": 40, "pass": 34, "fail": 3, "expectedLimitation": 3 },
    "failures": [{ "id": "FAIL-017", "reason": "fields=correctMatch · grade=possible" }] }
  ```

* 只有当 summary 里出现失败时，才去读 `qa/failures/FAIL-xxx.json`。
* 需要看 HTML 时，由开发者手动提供该页面的本地快照（`*.real.html`，git-ignored）。

## 10. 第一阶段记录的已知问题（先记录，第 4 阶段再修）

1. **Cleaning Bug — 标题尾部的站点后缀没被剥掉**（案例 RW-004，实测 FAIL）
   `[示例漫画网] サンプル作品ガンマ 第2話 - Online Reader` 清洗成
   `サンプル作品ガンマ - Online Reader`，作品名对不上，最终 0 命中。
   文本模式 `\b(?:read|online|free|raw|scan)\b`（`src/lib/cleaner.js` 的
   `SITE_NOISE_PATTERNS`）没有覆盖「 - Online Reader」这种组合后缀。
   影响：False Negative 增加（§15.6）。
2. **Cache Bug — 负缓存命中时仍然会重新请求**（`src/lib/pipeline.js`）
   `searchStore()` 只把「带条目的缓存」当成命中：

   ```js
   if (cached && Array.isArray(cached.items) && cached.items.length) { … fromCache = true }
   else { /* 重新搜索 */ }
   ```

   也就是说，`Cache.set(cacheKey, { items: [] })` 写进去的 `not-found` 记录在 TTL
   内不会被使用，「已经有缓存 → 0 新请求」（§24）对 negative 结果不成立。
   Capture 里已经记录 `cacheEntryFound` / `requests.observations`，可以直接量化
   影响范围后再决定改法。
3. **Matching 观察 — 一字之差的作品得到 78 分并被标为 possible**（案例 RW-007）
   `サンプル作品オメガ` vs 商品 `サンプル作品ガンマ` 的 bigram Dice 相似度是 78，
   高于 possible 阈值 62，于是会作为「可能的正版商品」列出。是否要在真实数据上
   收紧（例如对「长度相同但只有 1–2 个字不同」的短标题加惩罚）留到第 2/4 阶段决定。
4. **Store Adapter 限制 — Pixiv / Fantia 的空结果需要登录才有意义**
   两者在未登录时只会返回全年龄结果或需要登录，插件已经在 Popup 里说明原因
   （`emptyResultNote`），Capture 里记录 `stores.health`，不会断言「作品不存在」。
5. **已验证符合设计**：非漫画页 / 搜索页 0 请求（RW-012、RW-013）、
   命中后不再查其它商店（RW-001、RW-010）、第二次分析 0 请求（全部案例
   `cacheBehavior` PASS，`cacheMissed 0`）。

### 10.1 第一轮真实 Chrome 试跑（2026-09-12）修掉的工具问题

第一次在真实浏览器里跑（一条画廊页：标题只有英文 + 日文原名）时，
**插件本身的识别 / 匹配没有出问题，QA 工具自己出了 5 个问题**。
这些属于「工具坏了就没法测试」，而且都在 QA 层（不涉及 matcher / cleaner），
所以在第一阶段就修掉了：

| # | 现象 | 原因 | 修法 |
| --- | --- | --- | --- |
| 1 | 捕获失败时什么也看不到，计数永远是 0 | `captureForQa` 的 catch 只 `console.warn` | 写入 `mn:qa:error`，Popup 里用 ⚠️ 显示（§28「错误信息」） |
| 2 | Popup 显示 `Captured 0`，其实只是**静态占位文本** | `QA_GET` 失败被静默吞掉 | 未拿到数据时显示 `读取中…`，失败时显示 ⚠️ 与原因 |
| 3 | 扩展热重载后 Popup 说「当前页没有记录」 | 「当前页」来自 SW 内存里的 `tabStates`，而 MV3 的 SW 会被回收 | 回退到 `chrome.tabs.get(tabId).url` |
| 4 | 点 PASS / FAIL / 建案例后「当前页」变空、按钮变灰 | Popup 不是标签页，`sender.tab` 是 undefined，回复里带不回当前页 | 消息里显式带 `tabId`，SW 优先使用它 |
| 5 | 判定「不正常」时无处写原因 | 面板缺备注输入框（§14 / §15.6 要求记录原因） | 加备注框，内容随测试案例一起保存 |

另外补了一个 **`[复制本页记录]`** 按钮：怀疑**采集本身**不对（字段错、指纹错、
图片数恒为 0、SPA 标记不对）时，先把结构化记录拿出来人工核对，
再决定这是「采集 bug」还是「识别 bug」。

这一轮同时确认：真实页面上捕获成功（`G-H1-OG-NJ-IMG8-INFO-STATIC`、novelty 100、
8 次请求、pageType=gallery）；备注 / 判定 / 测试案例在扩展热重载后依然保留
（存在 `chrome.storage.local`）；`[Export Summary]` 产出约 2 KB 的 `qa-summary-*.json`。

### 10.2 第一轮真实数据发现的两类问题（2026-09-12，待集中修复）

#### 样本台账（用户报告 → 归因 → 建议修法 → 状态）

| # | 报告的现象 | 归因 | 建议修法 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | hitomi `/cg/…` 被判「不像漫画作品页」 | site-filter：URL 形态 + 无冒号信息块 | 见 (A) | 已记录（RW-014，FAIL） |
| 2 | hitomi `/reader/…` 同样不被识别 | site-filter：`read` 不匹配 `reader` | 见 (A) | 已记录 |
| 3 | DLsite 明明有商品却报未找到（标题中间多一个符号） | 检索召回：长关键词要求字面连续命中 | 见 (B) | 已记录（本机复现） |
| 4 | Fantia 明明有投稿却报未找到 | 会话/年龄限制：插件后台拿到的列表不含该投稿，空结果不可信 | 见 (D) | 已记录 |
| 5 | 只有英文标题时变体退化成半个标题 | cleaner：`\braw\b` 噪音规则截断 | 见 (C) | 已记录 |
| 6 | 人民币价格从哪来 / 会不会过期 | 没有汇率 API：DLsite 用商店自带 CNY，FANZA / Melonbooks 用写死常数 | 见 (E) | **已修复**（汇率集中到 `CONFIG.currency` + 设置里可改） |

#### (A) 站点判断：hitomi 的 `/cg/` 与 `/reader/` 形态被判成「不像漫画作品页」

采样（同一站三种路径形态）：

| 路径形态 | 结果 | 原因 |
| --- | --- | --- |
| `/cg/<slug>-日本語-<id>.html` | ❌ 未识别 | `cg` 不在 `DETAIL_URL_PATTERN` 里 |
| `/reader/<id>.html` | ❌ 未识别（阅读器页） | `reader` 不在模式里（模式里只有 `read`）；阅读器页也没有信息块 |
| `/doujinshi/<slug>-日本語-<id>-<id>.html` | ✅ 识别 | `doujinshi` 在模式里 → `manga-host-detail-url` |

真实页面上还有第二个原因：hitomi 的信息块标签是
`Group / Type / Language / Series / Characters / Tags`（**标签和值分成两个元素，没有冒号**），
而 `GALLERY_PAGE_SIGNALS` 全部要求 `标签 + :`，于是一条都不命中；
只剩 `manga-like-host`（故意设计成弱信号）→ 判定失败。

> 附带的实现细节：`GALLERY_PAGE_SIGNALS` 是按「命中了几条正则」计数的，
> 而 `tags / languages / uploaded / groups / pages` 等写在同一条正则的候选分支里，
> 所以一个只写了 `Language:` `Tags:` `Uploaded:` 的信息块只算 1 条命中，
> 达不到 `galleryHits >= 2` 的门槛。

候选修法（Phase 4 决定，都不改 matcher）：

1. `DETAIL_URL_PATTERN` 增加 `cg | reader` 这类常见形态
   （它们本来还要配合 `manga-like-host` 或其它信号才会放行，风险有限）；
2. 让「信息块字段数」也能构成强信号：复用 `src/qa/fingerprint.js` 的
   `infoFieldsOf()`（它已支持无冒号的标签），配合 `imageCount` 或 host hint 做门槛；
3. 两者都做时，hitomi 的 `/cg/` 走 (1)，阅读器页走 (2)。

回归案例：`tests/real-world/extraction/RW-014.json`（占位数据，当前为 FAIL，修好后转绿）。

#### (B) 商店搜索：页面标题与商品名的**中间插入符号**导致长关键词 0 命中

案例：nhentai 页面（日文原名）与 DLsite 同人楼层（maniax）上的对应商品
（真实商品 ID 只留本机，不进仓库）。两者只差一个符号：商品名在标题中间多了一个 `♡`。

实测链条（2026-09-12，本机 + 真实商店页）：

| 环节 | 结果 |
| --- | --- |
| 清洗出的关键词 | 日文原名（**不含** `♡`） |
| 送出的关键词是否包含 `♡` | 否（`toStoreQuery` 会把符号换成空格） |
| matcher 对「页面标题 vs DLsite 商品名」的分数 | **100（exact）**——`normalizeForMatch` 会去掉 `♡` |
| DLsite 自己的搜索（完整标题关键词） | **0 件**：「条件に一致する作品は見つかりませんでした」 |
| DLsite 自己的搜索（只取前 22 字） | **1 件，正是该商品** |
| FANZA 同关键词 | 命中（价格 ¥924，匹配度 100） |

结论（与最初的猜测不同）：**问题不在「完全匹配」，matcher 本来就已经是模糊匹配**，
而且对这对字符串给的是满分。真正的瓶颈在**检索召回**：
DLsite 的搜索对长关键词要求「字面连续命中」，标题中间多一个符号就整串落空；
DLsite 自己的帮助文案也写着「一文字でも打ち間違いがあると検索にヒットしません／
長いキーワードの場合は短くして検索をお試しください」。

因此修法应该加在**查询生成**上，而不是放松 matcher（放松阈值只会抬高
False Positive，与 §15.5 的目标相反）：

1. **渐进截断变体**：完整标题失败时，依次用「前 N 字」的变体重搜
   （实测 22 字前缀即可命中，且只多花 1 次请求，命中后立即停止）；
2. **按符号切分的变体**：`A♡B` → `A B`、`A`、`B`（对端已有 `toStoreQuery`，扩展成多候选即可）；
3. 仍失败时再用**作者 / 社团名搜索 + 本地标题比对**兜底（现在只有 Pixiv 有作者入口，
   可以把它升级成「作者搜索 + 标题匹配」）。

预期收益：DLsite 这类「长标题 + 中间符号差异」的漏检会显著减少，
请求预算仍受 `CONFIG.search.maxQueries` / `maxVariantsToSearch` 约束（§23）。

#### (C) 顺带发现的清洗问题

英文标题里出现 `Raw` 这个词时，`SITE_NOISE_PATTERNS` 的
`\b(?:read|online|free|raw|scan)\b` 会把「Raw」之后的整段当成站点噪音切掉，
变体退化成标题的前两个词（真实标题只留本机）。本例里日文原名赢了所以没影响结果，
但如果页面只有英文标题，这个变体就是废的。建议把该模式限制在
「独立成段 / 位于末尾」的位置，或要求它和其它噪音词同时出现。

#### (D) 需要会话的商店：**空的搜索结果不可信**（Fantia / Pixiv）

案例：某个画廊页（Pixiv 作者已识别）——作品在 Pixiv 与 Fantia 上都存在
（真实作品 ID / 投稿 ID 只留本机，不进仓库），
但插件的 Fantia 结果报「未找到」，用户读成「Fantia 没有这部作品」。

实测链条（2026-09-12）：

| 环节 | 结果 |
| --- | --- |
| 插件实际请求的 URL | `fantia.jp/posts?brand_type=0&keyword=<日文原名>&stock=all&category=<全部分类>` |
| **同一个 URL 在登录态下打开** | **1 件命中**：正是那个投稿（`/posts/<id>`，标题与页面标题一致） |
| 插件（后台请求）看到的结果 | 空列表 → `not-found` → 商店行显示「未找到」 |
| 卡片（页面上浮窗）的文案 | 「暂未找到对应商品」——**没有区分「商店没有」和「需要登录、其实没搜到」** |

也就是说：搜索 URL 和解析本身没问题，问题在于**后台请求拿不到你那份会话/年龄确认状态**，
Fantia 返回的列表里就没有这个（R18）投稿，而插件把它当成了「商店没有」。
这正好踩中 §30 的那条底线：*「HTTP 200 + 解析到 0 条」不能当成「这部作品不存在」*——
对不同会话返回不同结果的商店（Fantia / Pixiv）尤其如此；§15.6 也要求
False Negative 必须带上原因。

候选修法（Phase 4 决定）：

1. **空的但需要会话的结果标记为「不可信」**：`stores.health` 增加
   `session-limited`（或把 kind 记为 `unverified`），QA 统计里不计入「商店确认没有」；
2. **文案改对**：商店行与卡片都要区分「未找到」与「需要登录才能搜索」，
   例如「Fantia 需要登录后搜索（当前结果不可信）」；
3. 想真正做到自动命中，需要让这类商店的搜索发生在**用户自己的页面上下文**里
   （例如在 fantia.jp 的标签页里发起，或走用户点击的手动搜索入口），
   这属于架构改动，建议单独评估。

> 注：`credentials: 'include'` 已经写在 Fantia / Pixiv 适配器里；这条记录说明
> 「带 Cookie」并不等于「拿得到和用户标签页一样的结果」，需要按结果可信度来处理。

#### (E) 人民币估算价：三套来源，两套是写死的常数

**项目里没有任何汇率 API**，`approxCny` 有三个不同来源：

| 商店 | 来源 | 位置 |
| --- | --- | --- |
| DLsite | **商店自己在搜索结果里给的 CNY 报价**（`data-currency_price='{"JPY":…,"USD":…,"CNY":…}'`） | `src/stores/dlsite.js` `parseCurrencyTable()` / `approxCny` |
| FANZA | 写死的常数 **× 0.044** | `src/stores/fanza.js` 的 `approxCny` |
| Melonbooks | 写死的常数 **× 0.05** | `src/stores/melonbooks.js` 的 `approxCny` |
| Pixiv / Fantia | 没有（`price` 本身就是 null） | — |

据此可以确认几点：

1. 展示的数字**既不是实时汇率，也不来自统一的换算层**；
   两套常数连「测量日期」都没标注，汇率一动就会静默偏掉，
   而且没有放进 `CONFIG`（违反项目「可调参数都在 config.js」的约定）；
2. DLsite 那条虽然可靠（商店自己换算），但和另外两条的**口径不同**
   （谁的四舍五入、什么时候更新都不知道），并排显示时容易被当成同一可信度；
3. **免费商品会显示错**：FANZA / Melonbooks 用 `Math.max(1, …)`
   把 0 円的商品算成 `approxCny = 1`，于是 UI 可能同时显示「免费 约 1 元」
   （DLsite 处理正确：`cny > 0 ? … : 0`）；
4. 缓存：CNY 跟着搜索结果一起缓存（positive TTL 30 分钟），
   相对「写死常数」这点延迟可以忽略。

**已按讨论结论实现（2026-09-12）**：

1. **DLsite 保持原样**：商店自己给的 CNY 优先，且免费商品仍然是 0
   （`src/stores/dlsite.js` 不变）；
2. **FANZA / Melonbooks 的写死常数删掉**，改为统一从
   `CONFIG.currency.jpyToCny` 取值——**默认 0.044**
   （参考 Google Finance 2026-09-12 07:54：1 JPY = 0.0437 CNY，四舍五入），
   来源与测量时间写在 `CONFIG.currency.jpyToCnySource` 里；
3. **汇率改为用户可录入**：Popup 设置里新增「人民币估算汇率（1 日元 = ? 元）」，
   留空即用内置默认（`settings.cnyPerJpy = null`），输入 0.001~1 之外的数字会被拒绝
   并提示；`isCustomRate()` 用来在 UI 上标注「自定义」；
4. **换算时机挪到生成卡片**（`src/lib/pipeline.js` 的 `toCandidateCard`，
   实现见 `src/lib/currency.js`）：所以**改汇率不需要清缓存**，
   连已经缓存 30 分钟的搜索结果也会立刻按新汇率显示；每次分析把生效汇率记进
   `state.meta.cnyPerJpy`（QA 捕获里也能看到）；
5. **免费商品不再显示「约 1 元」**：`estimateCny()` 对 0 円返回 0、对未知价格返回
   null、对不足 1 元的按 1 元，三家的口径终于一致；
6. 仍然**没有引入任何汇率 API**：不新增域名权限、不发额外请求。

回归测试：`tests/currency.test.js`（汇率解析 / 越界 / 免费 / 取整）、
`tests/pipeline.test.js` 里三条端到端（默认汇率 44 元、自定义 0.05 立刻变 50 元、
免费商品为 0）。

历史候选方案（保留备查）：

1. **只保留商店自己给的**：删掉 FANZA / Melonbooks 的手算估算，
   有官方换算才显示（少一个数字，零漂移、零假精度）；
2. 若一定要保留估算：常数搬进 `CONFIG.currency`，注明「测量日期 + 来源」，
   并把免费商品钳到 0；
3. 真要做实时汇率，需要新增第三方域名到 `host_permissions` 并发起外部请求——
   与「只访问商店域名 / 不引入无关第三方 / 请求预算」相冲突，本项目不建议采用。

## 11. 完成标准对照（§36）

| 完成条件 | 状态 |
| --- | --- |
| QA Capture Mode 工作 | ✅ Popup 开关，默认关闭 |
| 能生成结构化页面摘要 | ✅ `src/qa/record.js` |
| 不默认保存完整 HTML | ✅ 只存结构化字段（§4） |
| 可以识别页面结构类型 | ✅ `fingerprint.js`（gallery / reader / article / listing） |
| 可以发现新的页面结构 | ✅ novelty score + 「New page structure detected」 |
| 可以生成测试 Case | ✅ `[Create Test Case]` → `RW-nnn` + `tools/qa-import.mjs` |
| 真实 URL / 作品数据默认 git-ignored | ✅ `tests/sites.local.json`、`qa/` |
| 能导出紧凑 QA Summary | ✅ 约 2 KB |
| 能单独导出失败 Case | ✅ `qa-failures-*.json` → `qa/failures/FAIL-xxx.json` |
| 能统计 Store request 数量 | ✅ `requests.byStore`（分商店） |
| 能验证 cache hit | ✅ 第二次分析 `cacheBehavior`（离线也能验证） |
| 能验证 SPA navigation | ✅ `navigationType` / `analysisCount` + RW-008、RW-009 |
| 能验证 False Positive | ✅ Popup「误判」+ `expected.grade` 断言 |
| 能运行至少 30 个真实测试案例 | ▶ 工具就绪，已提交 13 个占位案例，真实案例待第 2 阶段补足 |
| 测试结果可以重复执行 | ✅ `node tools/qa-run.mjs`（离线重放） |
| 不影响普通用户模式 | ✅ QA 默认关闭；关闭时不写记录、不发请求、不显示面板 |

## 12. 第二轮测试建议（按 §17 配额）

1. 标准页面 10 个（每个不同站点 / 不同模板）。
2. 标题异常 10 个：`第12話` / `第12话` / `EP12` / `Vol.12` / `作品名 12` /
   `【作品名】第12話` / `作品名 - 免费漫画` / `作品名 - Online Reader` /
   `[Site Name] 作品名 第12話`。
3. 相似作品 5 个：完全版 / 総集編 / 番外編 / 第1巻 / 第2巻 / 同名不同作者。
4. 应该找不到 5 个：不存在的作品、Store 没在卖的作品、普通博客、新闻、视频页。
5. SPA / 动态 5 个：pushState、无限滚动、动态标题、没有 H1、标题只有日文或只有英文。
6. 特殊结构 5 个：图片为主要内容、多章节页面、标题含作者/Circle、无 og:title 等。

每发现一种新结构就 `[Create Test Case]`；结构重复的页面不必重复加入
（Popup 会提示 `This page is structurally similar to an existing test case.`）。
