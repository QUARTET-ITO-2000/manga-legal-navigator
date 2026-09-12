# 开发与实测记录（中文长文档）· 漫画正版导航 v0.5.5

> 这份文档是**开发/实测笔记**：完整的需求对照、DLsite 真实行为、目录结构、变更记录与已知限制。
> GitHub 首页说明请见仓库根目录的 [README.md](../README.md)（English）、[README.zh-CN.md](../README.zh-CN.md)、[README.ja.md](../README.ja.md)。
>
> **文档约定**：本文档**不转载具体作品名、商品 ID 与商店链接**——需要举例的地方一律使用「サンプル作品」这类占位名。商店列表属于第三方内容，插件只在运行时于本机读取。

在漫画网页上自动识别作品名，帮你在 **DLsite** 上找到对应正版商品（商品名 / 价格 / 购买链接）。

实现依据：《漫画正版导航浏览器插件 · MVP 需求文档 v0.1》。
核心闭环就是需求文档最后那一段：

> 打开漫画页面 → 插件识别作品 → 搜索 DLsite → 找到正版 → 显示《作品名称》 DLsite ¥XXX **[查看正版]** → 用户自行决定是否购买

本 MVP 的优先级是「**作品识别 → DLsite 搜索 → 正确匹配 → 价格显示 → 购买链接 → UI 美化**」。
匹配策略刻意保守：**宁可显示「暂未找到」，也不推荐一个错误的商品**。

### 支持的页面类型

| 页面类型 | 例子 | 识别方式 |
| --- | --- | --- |
| 在线漫画阅读页 | `【作品名】第12话 - 免费漫画` | 标题里的章节标记 + 漫画关键词 + 正文采样 |
| **同人志画廊页** | 作品页形如「标题 + Tags / Groups / Languages / Pages 等信息字段」 | 信息块结构（≥2 个字段）+ 站点提示 + 多图 |
| 通用作品详情页 | `/comic/…`、`/gallery/…`、`/read/…` 这类 URL + 多图 + 漫画关键词 | URL 形状 + 图片数量 + 关键词组合 |

非作品页面（博客、新闻、搜索引擎、视频站、购物站等）会直接跳过，不出浮窗（测试 F）。

---

## 1. 安装（Chrome / Chromium 系）

1. 打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本目录（包含 `manifest.json` 的那一层）
4. 打开扩展详情页，把「**允许访问文件网址**」打开（这样才能用下面的本地测试页；访问正常网站不需要这一步）

要求：Chrome 102+（Manifest V3 + ES module service worker）。

安装完成后工具栏会出现图标；打开一个漫画页，右下角会自动出现浮动提示卡。

## 2. 30 秒看懂它做了什么

1. content script 读取当前页面的 `<title>` / `<h1>` / `og:title` / JSON-LD（需求文档 §6 的优先级）
2. 后台清洗标题：去掉网站名、广告语、章节号等（§7），**清洗不足时保留更多原文**，并保留多个搜索变体
3. 用清洗后的作品名搜索 DLsite 公开搜索页（§8）
4. 解析搜索结果里的商品名、价格、商品链接（§9）
5. 用字符串相似度打分（§10）：`>=85` 找到正版、`62~84` 可能的正版、`<62` 不展示
6. 在页面右下角用 Shadow DOM 浮窗展示结果，点击在新标签页打开 DLsite 商品页（§11 / §12）
7. Popup 里可以看到识别状态、切换设置、清除缓存（§13）

## 3. 本地测试页（需求文档 §20 的测试 A–F）

`tests/pages/` 下有 6 个可以直接用 `file://` 打开的页面，每个页面顶部都写了「本页期望」：

| 测试 | 文件 | 页面标题的特征 | 期望结果 |
| --- | --- | --- | --- |
| A 标准标题 | `test-a.html` | 「作品名 第1話 - 漫画 - 测试站」 | 识别出作品名（不含话数），用它去搜索 → 示例名没有商品，显示「暂未找到」+ 搜索入口 |
| B 带网站名 | `test-b.html` | 「【作品名】第12話 - 免费漫画 - 测试漫画网」 | 去掉【】/章节号/网站名 → 同上 |
| C 找不到作品 | `test-c.html` | 不存在的虚构作品名 + 章节号 | 显示「📚 正版购买 / 暂未找到对应商品」+「在 DLsite 搜索」，**不显示任何商品** |
| D 多个相似作品 | `test-d.html` | 「作品名 第12話 - 在线漫画 - 测试漫画网」 | 与 A/B 相同的清洗路径；页面里写明了怎么复现「候选列表」（换成商店中确实有多个版本的作品名） |
| E 成人漫画 | `test-e.html` | 日文成人在线漫画标题 + 第2話 + R18漫画网 | 与全年龄作品完全相同的流程（不做内容判断、不做年龄验证） |
| F 非漫画网页 | `test-f.html` | 「如何学习编程：给初学者的 10 条建议 - 我的博客」 | 页面**不出现浮窗**，Popup 显示「当前页面不像漫画作品页，未自动识别」，不会出现任何商品推荐 |

> 测试页里用的是**示例作品名**（不是真实作品名，也不是由真实作品改写）。A/B/D/E 会真的去 DLsite 搜一次，所以卡片会显示「暂未找到」+ 搜索入口——**这是预期结果**；把页面里的 `<title>` / `og:title` / `h1` 换成你自己在意的作品名，就能看到真实命中。
>
> **本仓库不包含具体作品的商品名、商品 ID 与商店链接**：`src/stores/fixtures/*.html` 也是「示例快照」——DOM 结构与真实页面一致，但商品名 / 商品 ID / 社团名 / 图片地址全部是占位数据。

打开方式：在 Chrome 里 `Cmd/Ctrl + O` 选择文件，或直接把文件拖进浏览器窗口。

> 测试 A/B/D/E 需要联网（会去搜索 DLsite）。若不方便联网，可在 Popup 里打开「使用离线示例数据（调试用）」，用 `src/stores/fixtures/` 下的示例快照验证解析与匹配链路。

## 4. 界面

**页面浮窗**（右下角，可收起为圆点、可关闭，不影响阅读；全部样式在 Shadow DOM 内，不受目标网站 CSS 影响）

```
┌──────────────────────────────┐
│ 📚 找到正版              – × │
│                              │
│ 《示例作品名》                │
│ [DLsite] 1,980円 约87元       │
│ 社团 / 作者                  │
│                              │
│ [ 查看正版 ]    [ 收起 ]      │
│ 是否购买由你自行决定…         │
└──────────────────────────────┘
```

- 「可能的正版」状态会显示「匹配度：很高/较高/一般/较低」，并列出前 3 个候选
- 没有找到时显示「在 DLsite 搜索」按钮，用清洗后的作品名打开 DLsite 搜索页
- 插件图标上的角标：`✓` 高可信匹配，`?` 可能匹配

**Popup**：当前页面标题与域名、识别出的作品名与来源、状态行（✓ 已识别作品 / ✓ 找到 DLsite 商品）、匹配商品信息、[查看正版]、[在页面显示]、[重新识别]，以及 4 个设置开关和「清除搜索缓存」。

## 5. 实测记录（DLsite 真实行为，2026-09 实测）

需求文档 §8 要求「不要假设固定 URL 永远有效」，所以下面的结论都是实测得到的，并提供了随时可重跑的探针（见 §7）：

| 观测项 | 实测结果 |
| --- | --- |
| 搜索页地址 | `https://www.dlsite.com/<section>/fsr/=/language/jp/keyword/<关键词>` |
| **空格编码** | 关键词里的空格必须写成 `+`；写成 `%20` 会被 WAF 直接 **403 Forbidden** |
| 关键词长度 | 少于 **3 个字符**时固定返回 0 结果（实测：2 个字符 = 0 条，4 个字符 = 30 条） |
| 分区差异 | `books` / `maniax` / `pro` 返回结果**完全一致**；`girls`（がるまに）是**独立索引**，用于女性向作品 |
| `/comic/` | 会 302 跳转到另一个站点 `comipo.app`，不在 MVP 范围内，未接入 |
| 无结果标记 | 结果容器里出现 `<div class="work_not_found"><p>条件に一致する作品は見つかりませんでした` |
| 结果条目结构 | `<li data-list_item_product_id="RJ…">` → `dd.work_name > a`（`title` 属性即完整商品名） |
| 价格结构 | `dd.work_price_wrap` 内 `span.work_price_parts`（现价），打折时同级还有 `span.strike`（原价）与 `span.icon_lead_01.type_sale`（如 `40%OFF`） |
| 汇率信息 | 每个条目带有 `data-currency_price='{"JPY":1980,…,"CNY":86.66,…}'`，卡片里的「约 XX 元」来自这里 |
| 商品链接格式 | `https://www.dlsite.com/maniax/work/=/product_id/RJ00000000.html`（注意是 `product_id/RJ…`，不是 `product_id=RJ…`） |
| 商品页 | `<h1 id="work_name">` 即商品名，价格同样是 `work_price_base` / `work_price_suffix` |
| 反爬 | 未登录、无 Cookie 的普通 GET 可以正常读取搜索页；实测连续请求未见限流，但仍做了 900ms 最小间隔 |

以下是用真实 DLsite 跑通的完整链路，**用示例标题代替真实作品名**（`tools/probe-dlsite.mjs` 输出格式）：

```
网页标题：【サンプル作品】第3話 - 免费漫画 - 示例漫画网
清洗结果：サンプル作品
状态：ok_high (找到正版商品)
匹配商品：《サンプル作品》 1,980円 分数=100
商品链接：https://www.dlsite.com/maniax/work/=/product_id/RJ00000000.html
候选：100 サンプル作品 / 100 【Android版】サンプル作品
```

同人志画廊页在浏览器里的实测链路（同样用示例标题）：

```
页面：https://<画廊站>/g/<作品编号>/  「[サークル名] サンプル作品タイトル」
      识别信号：gallery-structure（页面里有 Parodies / Tags / Groups / Languages / Categories / Pages）
清洗结果：サンプル作品タイトル（去掉了 » 站点名 与开头的 [サークル名]）
结果：《サンプル作品タイトル》 DLsite 385円（50%OFF，原价 770円） 匹配度 100
链接：https://www.dlsite.com/maniax/work/=/product_id/RJ00000000.html
```

> 真实的验证记录（哪个作品命中了哪家商店）只在本地保存，不写进仓库：**本仓库不转载具体作品名、商品 ID 与商店链接**。

> 备注：AdGuard 之类的广告拦截扩展不影响本插件 —— 抓取在 service worker 里完成，卡片也在独立的 Shadow DOM 中渲染，实测开着 AdGuard 一切正常。

## 6. 匹配与阈值（需求文档 §10、§22）

`src/matching/matcher.js` 用 4 种字符串策略取最大值：

1. 归一化后完全相同 → 100（NFKC、去空白、去标点符号、大小写统一）
2. 互相包含 → 按长度比例给分（`≥0.9 → 90`，`≥0.75 → 80`，`≥0.55 → 70`，`≥0.4 → 55`，否则 42）
3. 字符二元组 Dice 系数（中日文短标题表现最稳）
4. 最长公共子序列占比（应对少量插入/删除）

在比较前会先去掉装饰与章节：`【Android版】`、`[サークル名]`、`第12話`、`3巻`、`Episode 4`、`#5` 等。

判定：

| 分数 | 展示 |
| --- | --- |
| `≥ 85` 且与第二名差距 `≥ 6` | `📚 找到正版`（单一结果） |
| `≥ 85` 但与第二名接近 | `📚 找到正版` + 候选列表（避免武断选择） |
| `62 ~ 84` | `📚 可能的正版` + 「匹配度：…」 |
| `< 62` | 显示「暂未找到」，**不展示低分商品** |

所有阈值都在 [`src/lib/config.js`](../src/lib/config.js) 的 `CONFIG.matcher` 里，可按实测结果调整。

另外：如果网页标题里带章节号，而候选商品名里也有同一个数字，会 +5 分轻微加权（优先同一卷/话）。

## 7. 测试与自检

```bash
# 单元测试 + 端到端流水线测试（用示例快照驱动，共 142 项）
node --test tests/*.test.js

# 联网实测：验证 DLsite 的 URL 与解析是否仍然成立
node tools/probe-dlsite.mjs "サンプル作品名"
node tools/probe-dlsite.mjs --title "【サンプル作品】第3話 - 免费漫画 - 示例漫画网"
```

`probe-dlsite.mjs` 会打印：搜索 URL、HTTP 状态、解析到的条目数、前 5 个商品（含价格与链接），
以及走完整流水线后的清洗结果、匹配分数、前 5 名打分。**DLsite 改版后先跑它**，就能立刻知道是 URL 变了还是选择器变了。

覆盖的测试点：

- 标题清洗：`tests/cleaner.test.js`（测试 A / B / E + 不过度清洗的反例）
- 匹配与阈值：`tests/matcher.test.js`（测试 C / D / F、并列候选、章节加权、主变体优先）
- 页面筛选：`tests/site-filter.test.js`（测试 F、站点黑名单、漫画站白名单）
- DLsite 解析：`tests/dlsite-parser.test.js`（快照解析、折扣/原价、`&amp;` 实体、403、改版兜底）
- 端到端流水线：`tests/pipeline.test.js`（核心闭环、可能的匹配、无结果、成人向、缓存命中、失败提示）
- 浮窗模板：`tests/ui.test.js`（4 种状态渲染、免费价格、HTML 转义、未识别时不打扰）
- Popup 渲染：`tests/popup.test.js`（4 种状态、「读不到页面」提示、站内跳转时不会显示上一页的结果、同一份文档复用缓存）
- 站内跳转闸门：`tests/content-nav.test.js`（地址先变、内容后换时不会被拿去识别；换页期间 Popup 会等到新内容就绪）

## 8. 目录结构

```
extension/
├── manifest.json                    # MV3 配置（权限最小化：storage + activeTab + dlsite 域名）
├── package.json                     # 仅为让 Node 以 ESM 方式运行测试
├── icons/                           # 16/32/48/128 图标
├── src/
│   ├── content/
│   │   ├── extractor.js             # 读取页面信息（title / h1 / og / JSON-LD / 正文采样）
│   │   ├── ui.js                    # Shadow DOM 浮窗（找到正版 / 可能 / 未找到 / 错误）
│   │   └── content.js               # 流程编排 + SPA 换章检测
│   ├── background/
│   │   └── service-worker.js        # 唯一对外请求出口 + 每标签页状态 + 角标
│   ├── stores/
│   │   ├── store-adapter.js         # StoreAdapter 抽象（searchPlan / searchStep / parseResults / getProductInfo）
│   │   ├── dlsite.js                # DLsiteAdapter：URL 构造 + 结果解析
│   │   ├── registry.js              # 商店注册表（未来加 bookwalker / amazon / kobo）
│   │   └── fixtures/                # 示例快照（DOM 与真实页面一致，数据为占位）＋ local/（真实抓取，已 gitignore）
│   ├── matching/
│   │   └── matcher.js               # 相似度打分与展示分级
│   ├── lib/
│   │   ├── config.js                # 阈值 / 缓存时长 / 站点黑名单 等全部可调参数
│   │   ├── text.js                  # 归一化、实体解码、章节与装饰剥离、Dice/LCS
│   │   ├── cleaner.js               # 作品名提取与清洗（多来源 + 多变体）
│   │   ├── site-filter.js           # 「像不像漫画页」判断（避免测试 F 的误推荐）
│   │   ├── pipeline.js              # 分析流水线（不依赖 chrome API，可单测）
│   │   ├── cache.js                 # chrome.storage.local 缓存（30 分钟 / 无结果 5 分钟）
│   │   └── settings.js              # 设置读写
│   ├── qa/                          # Real-world QA（需求书 v0.1）
│   │   ├── fingerprint.js           # 结构特征 / 指纹 / Novelty Score / 分类
│   │   ├── record.js                # QA Capture 记录 + 测试结果表 + 统计
│   │   ├── export.js                # summary / failures / tests 三种导出 + 脱敏
│   │   └── storage.js               # chrome.storage.local 生命周期（含 Clear）
│   ├── shared/
│   │   └── protocol.js              # 消息类型与状态枚举
│   └── popup/                       # Popup 状态页（popup.html / popup.js / popup.css）
├── tests/                           # Node 测试 + 本地测试页
│   └── real-world/                  # 真实环境测试集（extraction / cleaning / matching / …）
└── tools/
    ├── probe-store.mjs              # 联网自检探针（--store … / --all / --json + 健康度）
    ├── probe-dlsite.mjs             # 旧入口（转发到 probe-store --store dlsite）
    ├── qa-run.mjs / qa-report.mjs / qa-import.mjs   # QA 重放 / 汇总 / 导入
    └── lint-anonymity.mjs           # 匿名性检查
```

> QA 阶段的完整流程（QA Capture、结构指纹、导出与脱敏、离线重放、已知问题清单）
> 见 [`QA.zh-CN.md`](QA.zh-CN.md)。

## 9. 隐私与权限（需求文档 §15、§19）

- 不建立账号、不收集浏览历史、不上传任何数据、没有自建服务器
- 后台只处理当前页面的公开信息（标题、h1、og、JSON-LD、正文片段），并且**只向 DLsite 发起搜索请求**
- 缓存只保存在本机 `chrome.storage.local`，键是搜索关键词的散列，不记录访问过哪些网页；Popup 里可一键清除
- 权限说明：
  - `storage`：保存设置与搜索结果缓存
  - `activeTab`：Popup 打开时读取当前标签页，用于展示状态与重新识别
  - `host_permissions: https://www.dlsite.com/*`、`https://www.dmm.co.jp/*`、`https://www.melonbooks.co.jp/*`：抓取这三家商店的公开搜索页（content script 受 CORS 限制，必须由后台发起）
  - 只有 FANZA 的请求会带上浏览器已有的 Cookie（为了复用年龄确认状态）；DLsite / Melonbooks 的请求不带 Cookie，也不会登录任何账号
  - content script 匹配 `http/https/file`：这是「读取当前页面」的必需项，安装时 Chrome 会提示「读取和更改您在所有网站上的数据」
- 明确不做（§19）：不登录 DLsite、不取用户密码、不改网页表单、不自动购买/下载、不绕过访问限制/DRM/验证码

## 10. 已知限制（诚实清单）

1. **中文/英文译名匹配不到**：DLsite 的索引以日文商品名为主。页面标题是中文译名或英文改题（画廊站上的英译标题）时，通常只能显示「暂未找到」+「在 DLsite 搜索」。这是数据层面的限制，不是清洗问题。
2. **DLsite 没有该作品**：商业出版社作品（例如集英社、讲谈社的作品）大多不在 DLsite 上，此时显示「暂未找到」是正确行为。
3. **短标题**：少于 3 个字符的关键词 DLsite 固定返回 0 结果；识别出的作品名很短时会走「在 DLsite 搜索」兜底。
4. **偏保守的匹配**：`< 62` 分一律不展示。像「溺愛彼氏」这种只是别的商品名中一部分的查询会显示「暂未找到」，而不是推荐一个相似但不相关的商品（这是需求文档 §22 的取舍）。
5. **站点标题格式特殊**：如果标题里没有分隔符、站点名和作品名连在一起（既没有括号也没有 ` - `），可能清洗不干净，导致搜索不到——此时仍旧只显示「暂未找到」，不会瞎猜。
6. **DLsite 改版**：解析基于实测的 HTML 结构，并有兜底：快照回归测试 + 解析不到条目时会返回 `no-items-parsed` 并提示「DLsite 搜索暂时失败」，**不会静默当成「没有结果」**。改版后用 `tools/probe-store.mjs --store dlsite`（或旧的 `tools/probe-dlsite.mjs`）重新校准 `src/stores/dlsite.js`。
7. **网络环境**：部分网络无法访问 DLsite，会显示「DLsite 搜索暂时失败」。另外插件对 DLsite 的请求遵循 900ms 最小间隔与 30 分钟缓存，避免造成压力。
8. **站内跳转（SPA）**：点链接不刷新页面时，靠 `pushState` 钩子 + 地址轮询（0.9s）发现换页，再等 DOM 静止 400ms 才识别（v0.3.0 的「换页闸门」）。等待上限 5s：极少数站点换页特别慢时会先用当前内容识别一次，换好后会自动重识别；确实没跟上时可在 Popup 点「重新识别」。
9. **社团名方括号**：像 `[社团名 (作者)] 作品名` 这种「方括号里是社团、后面才是作品名」的标题，第一个搜索变体仍保留方括号写法（第二个变体是去掉方括号后的作品名），个别作品会因此少搜到一个变体。
10. **浏览器**：优先 Chrome / Chromium。代码里没有用 Chrome 独有的 DOM API，理论上可移植到 Edge；Firefox 需要把 `chrome.*` 换成 `browser.*`（或加一层 shim）并调整 `background` 声明。

## 11. MVP 完成标准对照（需求文档 §21）

| 完成标准 | 状态 |
| --- | --- |
| Chrome 扩展可以正常安装 | ✅ 加载已解压目录即可 |
| Manifest V3 正常工作 | ✅ MV3 + module service worker |
| 可以读取当前网页标题 | ✅ `src/content/extractor.js`（title / h1 / og / JSON-LD / 正文采样） |
| 可以提取 / 清洗漫画作品名称 | ✅ `src/lib/cleaner.js`（含反例测试，避免过度清洗） |
| 可以向 DLsite 发起搜索 | ✅ 后台 `fetch`，实测 URL 与编码规则 |
| 可以解析至少一个 DLsite 搜索结果 | ✅ 解析 5 类字段，快照回归测试 |
| 可以获得商品名称 / 价格 / URL | ✅ 含折扣原价与人民币约值 |
| 可以进行基本标题匹配 | ✅ 4 种相似度策略 + 分级阈值 |
| 可以在页面显示结果 | ✅ Shadow DOM 浮窗（高可信 / 可能 / 未找到 / 错误） |
| 可以点击进入 DLsite | ✅ 新标签页打开商品页 |
| 无匹配时不会显示错误商品 | ✅ `< 62` 分不展示；非漫画页面直接不展示 |
| 插件不会明显影响原网页阅读 | ✅ 右下角小卡片，可收起/关闭，`pointer-events` 隔离，不参与页面布局 |
| README 包含安装和测试方法 | ✅ 本文档 §1、§3、§7 |

## 12. 后续版本方向（本 MVP 未实现）

- v0.2：作者/Circle 辅助匹配、ISBN 辅助匹配、更细致的标题清洗、多候选交互
- v0.3：折扣与活动信息、商品封面、更丰富的商品信息
- v0.4：AI 辅助作品识别（尤其解决中文译名）、多正版平台（BookWalker / Amazon / Kobo，只需新增 `src/stores/*.js` 并注册到 `registry.js`）、价格比较

## 13. 开发提示

- content script 不能用 `import`，因此 `src/content/content.js` 里有一份 `MSG` 常量副本，改动 `src/shared/protocol.js` 时要同步（文件里有注释标注）。
- `package.json` 里的 `"type": "module"` 只影响 Node 运行测试的方式，Chrome 不读取它。
- 修改阈值后请重跑 `node --test tests/*.test.js`，再用 `tools/probe-dlsite.mjs` 在真实数据上抽查。
- 对照真实页面：跑 `node tools/probe-dlsite.mjs "<关键词>" --raw` 看真实 HTML。**抓下来的真实页面请放到 `src/stores/fixtures/local/`（已 gitignore），不要提交**；要进仓库的快照必须是示例数据——结构与真实页面一致，但商品名 / 商品 ID / 社团名 / 图片地址都替换成占位值。
- **提交前先跑 `node tools/lint-anonymity.mjs`**：它会检查「已跟踪 + 未跟踪但没被 gitignore」的所有文件里的「标识符形态」——商店商品号（`RJ…` / `BJ…` / `d_…`）、`product_id=` 参数、画廊路径 `/g/000123/`、以及百分号编码的日文（真实标题最常见的漏网方式）。默认也会扫还没提交的新文件——上一次正是因为只扫已跟踪文件，刚写的新文件才漏检。
  - `tools/anonymity-allowlist.txt`（已提交）：允许出现的占位 ID 清单；
  - `docs/forbidden-names.local.txt`（已 gitignore）：**放真实作品名/社团名，一行一个**，命中即报错。这样检查脚本本身不含任何真实名字，同时又能防住旧错误复发；
  - `--cjk` 会额外打印注释 / markdown / 测试数据里的日文片段，方便人工复核示例是不是真名；
  - 某行含 `anonymity-lint: allow` 时跳过形态检查（用于百分号编码的占位串），但本地 denylist 仍然生效。

本项目假定使用者为成年人；MVP 不做年龄验证与内容审核（需求文档 §1、§3）。

## 14. 变更记录

**v0.5.5**

- **打包命令修正**：文档里的 `zip` 改为在仓库根目录执行，排除项补上 `*.local.*` 与 `*/fixtures/local/*`。此前只写了 `*.local.md`，于是 `docs/forbidden-names.local.txt`（本机真实作品名清单）被打了进去——发布包一旦外传，这份清单会跟着泄露。
- **`tools/lint-anonymity.mjs` 静默失效修复**：入口判断原本用 `file://${process.argv[1]}` 拼字符串与 `import.meta.url` 比对，而工作目录路径含空格（例如 `Codex Projects`）时两者不相等，脚本直接退出、一个文件都不扫，却依然返回成功。现改用 `pathToFileURL()`。
- **工程目录迁移**到 `~/Documents/Codex Projects/manga`；安装说明与打包命令里的版本号、目录名同步更新（打包不再依赖目录名）。
- 回归测试 143 项。

**v0.5.4**

- **结果按钮语义修正**：链接列表按「这家店有没有命中」排序与着色——有命中的商店高亮并前移（DLsite 优先，其余按 `CONFIG.stores.enabled` 顺序），没命中的保持灰按钮排在其后；当一个都没命中时，改为**作者入口高亮**（`found: true` 由 pipeline 在「无任何命中」时注入），因为它才是此时唯一有用的动作。Popup 与页面卡片共用同一份 `state.searchUrls`，样式判断一致（`.btn primary` / `.btn ghost`）。
- **Pixiv 作者链接参数修正**：`/search/users?nick=<名字>&s_mode=s_usr`（此前的 `?word=` 形式返回 0 个用户；实测换成 `nick` 后立刻返回目标作者页）。
- **作者名日语优先**：优先取日文标题方括号内的写法（`[らーめん] …`）；信息块 `Artists` / `Groups` 里是罗马音 slug（`ra-men 171`，且带站点消歧数字），拿它搜日文站点搜不到人，只作为兜底。
- 回归测试 143 项。

**v0.5.1**

- 修复 Fantia「永远搜不到」：
  - **实测**：`GET /api/v1/search/posts?q=<词>` 虽然返回 200 + 10 条 posts，但**忽略 `q`**（返回的是无关默认列表）——把它当成搜索接口是错的，会导致假阴性；
  - 真正的入口是**投稿搜索页** `GET /posts?brand_type=0&keyword=<词>&stock=all&category=<站点自己用的那串分类>`；匿名请求会 **302 → `/sessions/signin`**，即需要登录会话；
  - 现在适配器走搜索页（`credentials: 'include'` 复用浏览器登录态），按结果卡片解析：`a[href^="/posts/"]` 取文章链接与标题（锚文本形如 `<创作者>の投稿「<标题>」`，解析时去掉外壳），邻近的 `a[href^="/fanclubs/"]` 取社团名；
  - 响应落在 `/sessions/signin` 时标记为 **`login-required`**（Popup 里显示「需要登录」并提供登录入口），年龄确认页标记 `age-check`，都不会被当成「没有结果」。
- 顺带修 `tools/lint-anonymity.mjs`：`git ls-files` 会列出「已删除但尚未提交」的文件，之前会因读不到文件而崩溃，现在会跳过。
- 回归测试 141 项（Fantia 用例改为搜索页解析 + 登录墙 + 年龄确认 + 结构变化）。

**v0.5.0**

- 新增 **Fantia** 适配器（`src/stores/fantia.js`；检索顺序：DLsite → FANZA → Melonbooks → Pixiv → Fantia）：
  - **实测（2026-09）**：`GET https://fantia.jp/api/v1/search/posts?q=<词>` 返回 200 + JSON `{"posts":[{"id":…,"title":…}]}`，是公开接口；文章页 `https://fantia.jp/posts/<id>` 未登录也能 200；Fantia **没有** HTML 搜索页（`/search?q=` 是 404），所以 API 是唯一入口。与 Fanbox 不同，不需要私有代理和会话 token。
  - 解析 `posts[]` → 文章页链接 `https://fantia.jp/posts/<id>`、标题、社团（`fanclub.name`）；Fantia 的内容可能是免费或支援者限定，接口不返回价格，因此不标「免费」也不显示价格。
  - 年龄确认：请求带 `credentials: 'include'` 复用浏览器会话；若拿到的是年龄确认页（HTML 里含 `age_check` / `年齢確認` / `18歳以上`），标记为 `age-check` 并给出确认入口，**不会当成「没有结果」**；其它 HTML 响应按 `blocked`、非 JSON 按 `invalid-json` 处理。
  - `manifest.json` 新增 `https://fantia.jp/*`；离线示例数据新增 `fantia-search-sample.json`。
- 作者兜底改为**手动入口**（承接 v0.4.2）：Pixiv 的用户搜索接口只返回少量作品预览，因此不再由插件搜作者，而是在卡片 / Popup 的链接区提供 `Pixiv 作者: <名字>` 按钮（`https://www.pixiv.net/search/users?word=<名字>`）。开关仍由「用作者 / 社团名兜底搜索」控制，默认开。
- 正版商店页面不再被抓取：`DENY_HOSTS` 补上 `dmm.co.jp`、`melonbooks.co.jp`、`pixiv.net`、`fanbox.cc`、`fantia.jp`。
- hitomi 式 `/doujinshi/<slug>-<语言>-<id>.html` 详情页现在会被识别为作品页（详情页 URL 规则新增 `doujinshi`）。
- 回归测试 142 项。

**v0.4.1**

- 新增**作者兜底搜索**（可选，默认开启；Popup 里的「用作者 / 社团名兜底搜索」开关）：
  - `cleaner.js` 新增 `extractArtistNames()`：从页面信息块里按 `Artists:` / `Groups:` / `Circles:` / `Authors:` 标签切出作者 / 社团名（过滤 `original`、`japanese`、纯数字等噪声，最多 3 个）；
  - 适配器接口扩展为 `searchPlan(query, options)`，`options.artists` 由 pipeline 按设置注入；
  - Pixiv 适配器在有作者名时追加 tier-2 步骤 `GET /ajax/search/users/<作者>`，把返回的用户预览作品展开成候选（`body.users.data[].illusts[]`）——这正是「标题被改过、作者没变」的作品能被找到的原因（实测：某作品在 Pixiv 上标题多了后缀，仅靠标题搜索命中不到）；
  - 关掉开关时 `options.artists` 为空，请求数量与旧版本一致。
- 修复缓存导致的「改了代码界面不变」：缓存键加版本前缀 `mn:search:v2:`，适配器改动 item 结构后旧缓存自动失效（此前 Pixiv 结果缺 `store` 字段、误标 `isFree`，30 分钟内一直从缓存里读出旧对象）。
- Pixiv 结果不再声称「免费」：能打开不等于免费（可能是支援者限定或付费方案），搜索接口也不返回价格，因此价格字段留空。
- 回归测试 134 项。

**v0.4.0**

- 新增 **Pixiv** 适配器（`src/stores/pixiv.js`，注册在 `registry.js`，检索顺序：DLsite → FANZA → Melonbooks → Pixiv）：
  - 走 Pixiv 的 JSON 搜索接口：`https://www.pixiv.net/ajax/search/artworks/<词>?word=…&order=date_d&mode=all&p=1&s_mode=s_tag&type=all&lang=ja`；
  - 两级检索：先按**标签**（`s_mode=s_tag`），没有再按**标题 + 正文**（`s_mode=s_tc`）；
  - **实测（2026-09）**：匿名请求对 R-18 作品不可见——用一个热门成人标签做对照，`total` 不变但返回条目全是 `xRestrict: 0`，即使把 `mode` 换成 `r18` 也一样。因此请求使用 `credentials: 'include'` 复用浏览器里「已登录 + 已确认年龄」的会话（与 FANZA 同一套思路），插件本身不会代你登录；
  - 结果解析：`body.illustManga.data[]` → `productId`(id) / `title` / `author`(userName) / 作品页 URL `https://www.pixiv.net/artworks/<id>` / `ageRating`(xRestrict)；作品本身免费，所以价格字段留空而不是显示 0 円；
  - 空结果标记为 `not-found`；接口报错（`{"error":true,…}`、非 JSON、结构变化）一律返回 `ok:false` + 具体 reason，**不会静默当成「没有结果」**；
  - Pixiv 的「未找到」会在 Popup 的商店行里附带说明：R-18 需要登录并确认年龄（`emptyResultNote`，由适配器提供、pipeline 透传）。
- manifest 新增 `https://www.pixiv.net/*` 主机权限；离线示例数据模式新增 `src/stores/fixtures/pixiv-search-sample.json`（合成快照）。
- 回归测试 130 项（新增 7 项 Pixiv 用例）。

**v0.3.1**

- 修复「关键词里的标点 / 出处注释导致商店搜索直接 0 条」：
  - **实测（2026-09）**：同一部作品，关键词里带标点（例如 `サンプル！作品 第2巻`）时 Melonbooks 返回 0 条，换成空格分隔的形式（`サンプル 作品 第2巻`）就能搜到正确商品。也就是说关键词里的标点会让搜索静默失败——匹配打分不受影响（匹配器本来就忽略标点），失败发生在「搜索阶段」。
  - 新增 `toStoreQuery()`（`src/lib/text.js`）：发给商店的关键词把标点/符号替换成空格（不是删除，删除会把词粘在一起，同样是 0 条）；展示用的标题保持原样。`pipeline.js` 里 `state.query.searched` 记录实际搜索的关键词，Popup 诊断也显示它。
  - 新增 `stripTrailingSourceAnnotation()`（`src/lib/cleaner.js`）：结尾的「出处 / 规格」括号（杂志号 `(サンプルマガジン Vol.54)`、页数 `(…ページ)`、活动号 `(C…)`，即括号内含数字或 号/巻/ページ/Vol/版 等）在**剥离卷号之前**整块去掉；以前先剥 `Vol.54` 会留下 `(名称 )` 空壳括号，关键词因此搜不到东西。同时把「结尾版式标签（[DL版] 等）的剥离」提前到这一步之前，否则 `[DL版]` 会挡住更里层的括号注释。
- 实测（2026-09-11，真实商店，案例细节只保留在本地记录里，不写进仓库）：
  - 两部作品：关键词去掉标点后，Melonbooks 能搜到对应商品，**匹配度 100**；
  - 一部作品：章节是刊登在杂志上的，商店只卖那一期杂志，标题与章节名相似度 0，**因此仍显示「暂未找到」**（搜索链接现在能用；自动匹配等于推荐无法验证的商品，见 §10 已知限制 11）。
- 回归测试 117 项（新增 4 项：出处括号、非注释括号保留、`toStoreQuery`、端到端关键词不含标点）。

**v0.3.0**

- 修复「点开新页面后偶尔不读取信息，Popup 还显示上一个页面的结果」：
  - **根因**：这类画廊站点链接是**站内跳转**（地址变了、页面不重新加载，content script 也不会重建）。跳转过程中存在一个「**地址栏已经是新页面、DOM 还是上一页**」的中间态；在这个窗口里读取页面，就会拿到主页标语，于是 Popup 显示
    把画廊站**首页的标语**当成了作品名，并显示「暂未找到对应商品」。它不是随机发生的 bug，而是取决于你点多快打开 Popup。
  - content script 增加**换页闸门**：`history.pushState/replaceState`、`popstate`、轮询任一发现地址变化后，先挂起，等 DOM 真正换好内容并静止 400ms（最多等 5s）再识别；
  - 换页期间 `MN_REQUEST_PAGE_INFO` **不会立刻回答旧内容**，而是等新页面就绪后再回答，所以 Popup 不会被中间态骗到；
  - 换页开始就**移除上一个作品的浮窗卡片**（以前只是「不显示新卡片」，旧卡片会跟着新页面一直留在屏幕上）；
  - 新增页面一致性信号 `settled`：内容与 URL 对不上（`og:url` / `canonical` 指向别的地址）时，后台按「页面还没换好」处理，绝不会拿它去搜索；
  - 状态里记录产生它的文档编号（`page.scriptId`），Popup 用它判断「缓存结果是不是当前这份文档的」——同一份文档直接复用，换页了则重新识别；
  - Popup 打开时先显示「正在识别…」，等新页面就绪 + 后台搜索完成再显示结果；后台分析完成后会**广播**新状态，Popup 打开着也能自动刷新，不用手动点「重新识别」；
  - 后台只在「标签页仍停在同一个地址」时才写入状态，避免分析期间用户已经翻页、结果却写回去。
- 实测（2026-09-11，Chrome 真机，画廊站主页随机点进作品页并在 100ms 内打开 Popup）：多次抽样都能正确识别当前页并在 DLsite / FANZA 命中对应商品，且不再出现主页标题。**具体作品名、商品 ID 与商店链接不记录在仓库里。**
- 新增回归测试 `tests/content-nav.test.js`（站内跳转闸门）并扩充 Popup / 站点判断测试：合计 113 项。

**v0.2.2**

- 站点根路径 / 列表页保护：`/`、`/index.html` 直接判定为「不是作品页」，避免主页被当成作品页分析。
- 从页面识别信号里去掉导航栏文案（`navHint`）：画廊站主页的列表标题里带「漢化」「同人」等词，会被误当成「这是作品页」的证据。

**v0.2.1**

- Popup 命中「上一个页面的缓存状态」时会丢弃并重新识别（`isStaleState`）。
- 后台为同一标签页同一地址的进行中分析做去重，避免刚打开 Popup 时重复请求商店。

**v0.2.0**

- 新增 **FANZA** 与 **Melonbooks** 两个商店适配器（需求文档 §17 的 StoreAdapter 抽象在这里派上用场）：
  - 检索顺序 DLsite → FANZA → Melonbooks，任一家给出高可信度匹配就停止；都没有时卡片给出三家商店的搜索入口；
  - FANZA 按「方案 A」复用浏览器里已有的年龄确认 Cookie（`credentials: 'include'`）；拿到年龄确认页时**明确提示需要确认**，而不是当成「没有结果」；
  - Melonbooks 用 `adult_check_flg=1` 直接抓，无需 Cookie；
  - Popup 新增「正版商店」区块，逐店显示：找到的商品 / 需要年龄确认 / 未找到 / 查询失败（都带手动搜索入口）。
- 新增 `manifest.json` 主机权限：`www.dmm.co.jp`、`www.melonbooks.co.jp`。
- 修复识别层（承接 v0.1.6 的实测）：
  - 页面标题类元素改为 h1–h4 + `role="heading"` + `aria-level` + `#info .title` 全量收集，并过滤 `More Like This` / `Post a comment` / `Save this search` / `#<作品编号>` 等栏目标题；
  - 标题候选按 `含假名（日文）> 只有汉字 > 纯拉丁` 排序后再取前几个搜索（DLsite 上基本都是日文商品名）；
  - 双语标题（`日文原名︱中文译名`）只保留日文原名，`[中国翻訳]`、`[サンプル汉化组]` 等翻译标签会被去掉。
- 离线快照新增 FANZA / Melonbooks / FANZA 年龄确认页；回归测试 97 项。
- 实测：有作品在 DLsite 搜不到、却能在 **FANZA 命中**，卡片会直接显示 FANZA 商品（验证了多商店检索确实能补上 DLsite 的缺口）。

**v0.1.6**

- 按「DLsite 上基本都是日文商品名」这一事实，把标题候选彻底改成**日语优先**：
  - 变体按「含假名 > 只有汉字 > 纯拉丁」排序后再取前几个去搜索，罗马音 / 英译 / 中文译名都不会再抢到主搜索词；
  - 收集页面上**所有标题类元素**（`h1`–`h4`、`role="heading"`、`aria-level`、`#info .title`）——画廊站在不同类目下会把日文原题放在不同标签里，只读 `h1/h2` 会漏掉；
  - 过滤 `More Like This`、`Post a comment`、`Save this search`、`#<作品编号>` 这类栏目标题；
  - 双语标题（`日文原题︱中文译名`）只保留日文原题；`[中国翻訳]`、`[サンプル汉化组]` 等翻译标签会被去掉；
  - 开头的方括号一律视为标签（社团 / 作者 / 版本），去掉后如果只剩章节号则保留原样。
- Popup 的「诊断」新增**页面标题元素清单**，可以直接看到插件从页面上抓到了哪些标题、最终选了哪个搜索词。
- 实测（2026-09-11，随机抽样 6 部）：其中 2 部在 DLsite 命中商品（含商业电子书分区），另外 4 部 DLsite 没有对应商品 → 正确显示「暂未找到」。
- 回归测试 87 项。

**v0.1.3**

- 修复「同人站把日文原题放在 `<h2>` 时识别不到」的核心问题（这是上一个版本没根治的原因）：
  - 这类画廊站的结构是 **h1 = 罗马音/英译标题，h2 = 日文原题**，而此前只读 h1，所以永远拿不到日文商品名；
  - 现在 h1 / h2 / h3 都作为标题来源（权重依次降低），并过滤掉 `More Like This`、`Post a comment`、`#<作品编号>` 这类栏目标题；
  - 变体去重改为「忽略方括号内容」，`标题 [English] [Digital]` 与 `标题` 视为同一个变体，不会挤掉日文原题的名额；
  - 主变体是纯拉丁（罗马音）而另有一个含日文的变体时，**优先用日文原题**搜索 DLsite。
- 实测案例：一部「罗马音标题 + 日文原题」并存的作品，改用日文原题后一次搜索就命中 DLsite 商品；此前拿罗马音标题去搜只能得到 0 条。
- 回归测试增加到 83 项。

**v0.1.2**

- 修复「作品名带副标题时识别错误」（标题内部的多段切分问题）：
  - 标题按 ` - ` / ` | ` / `»` 切分后改为**取最前面的片段**（原先取最长片段，结果是更长的英文副标题被当成了作品名）；
  - 同人站常有的多个 `<h1>`（罗马音标题 + 日文原题）现在**全部作为候选来源**；
  - 一次分析会**用前 2 个变体各搜一次** DLsite（先搜罗马音标题、再搜日文原题），避免只搜了副标题就判定「没找到」；
  - 支持去掉结尾的版本/语言标签（`[DL版]` `[英訳]` `[English]` `[Digital]` `[無修正]` …）；
  - 修正括号解析：`[Circle Name (Author)] 标题` 这类「英文社团名 + 日文原题」不会再被括号里的小括号截断（原先会残留一个 `]`）。
- 回归测试增加到 79 项（新增 7 项覆盖副标题 / 多 h1 / 多变体搜索）。

**v0.1.1**

- 修复「同人志画廊站识别不到作品」的问题：
  - 页面识别新增 `gallery-structure` 信号（Tags / Groups / Languages / Pages / Parodies 等信息块），并把若干画廊站的域名加入漫画站白名单（域名清单见 `src/lib/config.js` 的 `MANGA_HOST_HINTS`）；
  - 标题清洗支持 `»` 分隔符（`作品名 » 站点名`），并识别「`[社团名] 作品名`」这种前缀标签（方块里是作者而不是作品名时不再把它拼进搜索关键词）；
  - 顺带收紧了「多图 = 作品页」的判定：只有详情型 URL + 多图才算，避免把图片多的普通文章误判成作品页。
- Popup 新增「诊断」行：识别失败或没找到时，直接显示原因、识别信号与搜索关键词，便于排查具体卡在哪一步。
- 离线快照补充了画廊页场景，并新增 8 项回归测试（共 72 项）。

**v0.1.0**：首个 MVP（页面读取 → 标题清洗 → DLsite 搜索 → 匹配 → 页面浮窗 / Popup）。

## 15. 多商店检索（v0.2.0 已实现）

需求文档 §23 把「多正版平台」列在后续版本；实际已按用户要求实现，用于判断「这部作品是不是商业作品 / 是否只在别的平台发售」。

### 检索顺序与提前结束

```
DLsite（主变体 + 备用变体，必要时再查女性向索引）
   ↓ 没有达到「高可信度」
FANZA
   ↓ 还是没有
Melonbooks
   ↓
仍然没有 → 卡片显示「暂未找到」，并给出三家商店的搜索入口
```

- 只要某一家给出高可信度匹配（≥85 分）就立即停止，不再打扰后面的商店
- 结果缓存按商店分别缓存 30 分钟（无结果 5 分钟）

### 各商店实测入口与解析方式

| 商店 | 搜索入口 | 条目结构 | 备注 |
| --- | --- | --- | --- |
| DLsite | `https://www.dlsite.com/<section>/fsr/=/language/jp/keyword/<kw>/` | `li[data-list_item_product_id]` + `dd.work_name` / `dd.work_price_wrap` | 空格必须写成 `+`，见 §5 |
| FANZA | `https://www.dmm.co.jp/search/=/searchstr/<kw>/` | `/-/detail/=/cid=d_XXXXXX/` + `p.text-sm.font-bold`（标题）+ `770円` + `サークル：…` | **需要年龄确认 Cookie**，见下 |
| Melonbooks | `https://www.melonbooks.co.jp/search/search.php?name=<kw>&adult_check_flg=1` | `li.product_<商品ID>` + `p.item-ttl.product_title` + `p.item-price` | 无 Cookie 需求 |

> FANZA 同人专区自己的搜索入口（`/dc/doujin/-/search/=/searchstr=…/`）会 302 到一个 404 页面，因此走全站关键词搜索。

### FANZA 的年龄确认（方案 A：复用浏览器 Cookie）

- 请求时使用 `credentials: 'include'`，复用浏览器里已有的 `age_check_done=1`（你平时访问 FANZA 时已经确认过）
- 如果拿到的是年龄确认页，插件不会假装「没有结果」，而是标记为 `age_check`：
  - 页面卡片显示「FANZA 需要先确认年龄：[打开确认页面]，回来后再点「重新识别」」
  - Popup 的「正版商店」列表里 FANZA 一行显示「需要年龄确认」+「去确认年龄」
- 只有这一家的请求会带 Cookie；DLsite / Melonbooks 依旧 `credentials: 'omit'`
