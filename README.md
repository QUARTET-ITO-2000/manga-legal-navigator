# Manga Legal Navigator

**Read a manga page → instantly see whether there is an official copy of it on DLsite, FANZA or Melonbooks — and where to buy it.**

`manga-legal-navigator` is a Manifest V3 extension for Chrome / Chromium. It reads the page you are on, works out the work's title (Japanese original preferred), searches the official shops, scores every result, and shows a small card with the product name, price and a direct link.

If the match is not convincing, it says **“no matching product found”** and offers manual search links. It never recommends a random look-alike.

**Read this document in:** **English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

![Manifest V3](https://img.shields.io/badge/manifest-v3-blue)
![Chrome](https://img.shields.io/badge/Chrome-102%2B-4285F4)
![Tests](https://img.shields.io/badge/tests-113%20passing-2ea44f)
![Version](https://img.shields.io/badge/version-0.3.0-informational)
![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)

> ### Scope and disclaimer
>
> * This tool deals with **adult (R18) content** and is intended for **adults only**.
> * It **only reads public pages** and **links to official stores**. It does not log you in, does not add anything to a cart, does not buy, download, or bypass paywalls, DRM, captchas or age gates.
> * It does not judge whether a page is legal or not, and it does not report anything anywhere. Everything is processed locally on your machine.
> * Store names and trademarks belong to their respective owners. This project is not affiliated with DLsite, FANZA (DMM) or Melonbooks.

---

## Table of contents

- [What it does](#what-it-does)
- [Supported page types](#supported-page-types)
- [How it works](#how-it-works)
- [Supported stores](#supported-stores)
- [Install](#install)
- [Usage](#usage)
- [Verification](#verification)
- [Privacy and permissions](#privacy-and-permissions)
- [Tuning](#tuning)
- [Development](#development)
- [Known limitations](#known-limitations)
- [Changelog](#changelog)
- [Roadmap](#roadmap)
- [License](#license)

---

## What it does

* **Reads the current page** — `<title>`, `h1`–`h4`, `og:title`, JSON-LD, the gallery info block (`Tags / Groups / Languages / Pages`) and a text sample.
* **Extracts and cleans the work title** — strips site names, ad text, chapter numbers, `[DL版]` / `[Chinese]` style tags, and prefers the **Japanese original** over romanised or translated titles (the shops index Japanese product names).
* **Searches official shops in order** — DLsite → FANZA → Melonbooks; it stops as soon as one store gives a high-confidence hit.
* **Scores and grades the result** — `≥85` *found*, `62–84` *possible* (with up to 3 candidates), `<62` *not shown at all*.
* **Shows a floating card** on the page (Shadow DOM, collapsible / dismissible, does not affect the site's layout) plus a **toolbar popup** with details, settings and cache controls.
* **Survives client-side navigation** — on sites that swap content without reloading the page (some gallery sites do this), a *navigation gate* waits for the new page to actually render before it reads anything (that is what v0.3.0 fixed; see [Changelog](#changelog)).
* **Is quiet by default** — on pages that don't look like a work page, nothing is shown and no requests are made.

### What a result looks like

The floating card on the page:

```
┌────────────────────────────────┐
│ 📚 Found officially      –  ×  │
│                                │
│ 《Example Work Title》          │
│ [DLsite] 1,980 JPY ~ 87 CNY     │
│ Circle / Author                │
│                                │
│ [ View product ] [ Collapse ]  │
│ Deciding to buy is up to you.  │
└────────────────────────────────┘
```

The popup shows the same information plus: the recognised title and where it came from, the per-store verdict (found / not found / age check needed / request failed), match confidence, and a “Show on page” / “Re-analyse” button.

---

## Supported page types

| Page type | Example | How it is recognised |
| --- | --- | --- |
| Online reader page | `【作品名】第12話 - 免费漫画` | chapter marker in the title, manga keywords, text sample |
| Doujinshi gallery page | a work page that lists fields such as `Tags / Groups / Languages / Pages` | info-block structure (≥2 fields) + host hint + many images |
| Generic work detail page | URLs containing `/comic/…`, `/gallery/…`, `/read/…` + many images + manga keywords | URL shape + image count + keyword combination |

Anything else (blogs, news, search engines, video and shopping sites) is skipped: no card, no network requests.

---

## How it works

```
content script (page)                     service worker (background)
──────────────────────────────────────    ─────────────────────────────────────────
read title / headings / og / JSON-LD  ──▶ score the page ("does this look like a work?")
read gallery info block                   clean the title → search variants
watch for client-side navigation          DLsite → FANZA → Melonbooks
                                          parse results, match, grade
render a Shadow-DOM card             ◀──  build a state object (found / possible / none)
```

1. **content script** collects page information and sends it to the background (`src/content/extractor.js`).
2. **site filter** decides whether the page is worth analysing (`src/lib/site-filter.js`).
3. **cleaner** turns the raw title into a searchable work name and several variants (`src/lib/cleaner.js`).
4. **store adapters** build search URLs, fetch them (only the background may do cross-origin requests) and parse the result pages (`src/stores/`).
5. **matcher** scores every candidate with four string-similarity strategies and grades the best one (`src/matching/matcher.js`).
6. The resulting state is rendered as a card and cached per tab; the popup reads the same state.

Everything above the chrome-API boundary is pure functions, so the whole pipeline is unit-testable in Node against the HTML snapshots in `src/stores/fixtures/`.

---

## Supported stores

| Store | Search entry point | Result structure | Notes |
| --- | --- | --- | --- |
| **DLsite** | `https://www.dlsite.com/<section>/fsr/=/language/jp/keyword/<kw>/` | `li[data-list_item_product_id]` + `dd.work_name` / `dd.work_price_wrap` | spaces in the keyword **must** be `+`; `%20` is rejected with HTTP 403 |
| **FANZA** (DMM) | `https://www.dmm.co.jp/search/=/searchstr/<kw>/` | `/-/detail/=/cid=d_XXXXXX/` + `p.text-sm.font-bold` + `770円` + `サークル：…` | needs the age-check cookie — see below |
| **Melonbooks** | `https://www.melonbooks.co.jp/search/search.php?name=<kw>&adult_check_flg=1` | `li.product_NNNNNNN` + `p.item-ttl.product_title` + `p.item-price` | no cookie needed |

### FANZA and the age gate

FANZA requests are sent with `credentials: 'include'`, so the extension **reuses the age confirmation your browser already has** (`age_check_done=1`). If the response is an age-check page, the extension does **not** pretend there was no result: it marks that store as *“age check required”* and offers a link to complete the check, after which you can press “Re-analyse”.

Only FANZA requests carry cookies; DLsite and Melonbooks are always fetched without credentials.

---

## Install

### Requirements

* Chrome / Chromium **102 or newer** (Manifest V3 with an ES-module service worker). Edge works too.

### From a release archive

1. Download and unzip `manga-dlsite-navigator-v0.3.0.zip`.
2. Open `chrome://extensions/` and turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the folder that contains `manifest.json`.

### From a git clone

```bash
git clone https://github.com/<your-account>/manga-legal-navigator.git
```

Then load the repository folder itself with **Load unpacked** — no build step, no bundler, no dependencies.

Optional: in the extension details page, enable **Allow access to file URLs** if you want to try the offline test pages in `tests/pages/`. Normal websites do not need this.

---

## Usage

1. Open any manga / doujinshi page. If the extension recognises a work, the card appears in the bottom-right corner within a second or two.
2. Click **View product** (or the popup's “View product”) to open the store page in a new tab. Deciding to buy is entirely up to you.
3. Click the toolbar icon for details: the page title, the recognised work, per-store verdicts, match confidence, and settings.
4. If something looks wrong, press **Re-analyse** — or open the popup after a page change and it will re-check the page for you.

### Popup settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Enable extension | on | Master switch. Off = no reading, no requests, no card. |
| Show the card automatically | on | When off, results only appear in the popup / when you press “Show on page”. |
| Use offline sample data (debug) | off | Runs the whole pipeline against the sample HTML snapshots in `src/stores/fixtures/` — no network requests. |
| Skip the “is this a manga page?” check (debug) | off | Analyses every page, useful when developing a new site adapter. |

The popup also shows how many cached searches are stored and has a **Clear search cache** button.

---

## Verification

Checked by hand in Chrome on 2026-09-11 against live doujinshi gallery pages and all three stores:

| What was checked | Outcome |
| --- | --- |
| Title extraction on a gallery page, where the Japanese original sits in a secondary heading next to a romanised/English one | the Japanese original is used for the search |
| A work sold on DLsite, including a discounted item | product name, current price, original price and sale label are read correctly |
| A work that is **not** on DLsite but **is** on FANZA | the FANZA result is shown and DLsite is reported as “not found” |
| A work sold on Melonbooks | Melonbooks result and price are shown |
| Works that none of the three stores carries | correctly reported as “not found” — no wrong product is recommended |
| Client-side navigation: opening the popup **within ~100 ms** of clicking a gallery link | the new page's work is shown, never the previous page's title |

> **Documentation policy:** this repository contains **no real work titles, product IDs or store links** — not in the docs, not in the tests, not in the fixtures. Everything you see is placeholder data (`サンプル作品アルファ`, `RJ00000000`, …). Store listings are third-party content and are only read at runtime, on your own machine. To re-run the checks, open a gallery page you are interested in and compare the card with the store's own search results.

---

## Privacy and permissions

* No account, no telemetry, no analytics, no server of any kind.
* The extension reads **public page data only** (title, headings, `og:`/JSON-LD, gallery info block, a text sample) and sends search queries **only** to the three stores above.
* Cached results live in `chrome.storage.local` on your machine. Cache keys are hashes of the search keyword; **no browsing history is stored**. The popup can clear the cache.

| Permission | Why it is needed |
| --- | --- |
| `storage` | save settings and the search-result cache |
| `activeTab` | the popup reads the current tab to show its status and to re-analyse on demand |
| `host_permissions` for `dlsite.com`, `dmm.co.jp`, `melonbooks.co.jp` | fetching public search pages; content scripts cannot do this cross-origin, so the background does it |
| content script on `http/https/file` | reading the page you are looking at. Chrome will show “Read and change all your data on all websites” — this is inherent to any extension that reads page titles. |

**Deliberately not implemented:** logging into any store, handling passwords, submitting forms, automatic purchases or downloads, and bypassing access restrictions, DRM, captchas or age gates.

---

## Tuning

All thresholds and timings live in [`src/lib/config.js`](src/lib/config.js):

| Key | Default | Meaning |
| --- | --- | --- |
| `matcher.high` | 85 | score at which a match is reported as *found* |
| `matcher.possible` | 62 | score at which a candidate is shown as *possible* |
| `matcher.minCandidate` | 50 | candidates below this are never displayed |
| `matcher.tieMargin` | 6 | if the runner-up is this close, candidates are listed instead of picking one |
| `cache.positiveTtlMs` | 30 min | cache lifetime for hits |
| `cache.negativeTtlMs` | 5 min | cache lifetime for “not found” (short, so new releases appear quickly) |
| `search.minIntervalMs` | 900 ms | minimum delay between store requests (be polite) |
| `search.timeoutMs` | 12 s | per-request timeout |
| `extractor.urlPollMs` | 900 ms | how often the content script polls for URL changes |
| `extractor.settleQuietMs` / `settleMaxWaitMs` | 400 ms / 5 s | navigation gate: how long the DOM must stay quiet, and the maximum wait |

---

## Development

### Repository layout

```
manga-legal-navigator/
├── manifest.json                  # MV3: minimal permissions + 3 store hosts
├── package.json                   # only used so Node runs the tests as ESM
├── icons/                         # 16 / 32 / 48 / 128 px
├── src/
│   ├── content/
│   │   ├── extractor.js           # reads page info (title / headings / og / JSON-LD / samples)
│   │   ├── ui.js                  # Shadow-DOM card (found / possible / not found / error)
│   │   └── content.js             # orchestration + the client-side-navigation gate
│   ├── background/
│   │   └── service-worker.js      # the only place that talks to the network; per-tab state; badge
│   ├── stores/
│   │   ├── store-adapter.js       # StoreAdapter interface (searchPlan / searchStep / parseResults)
│   │   ├── dlsite.js              # DLsite adapter
│   │   ├── fanza.js               # FANZA adapter (cookie reuse + age-check handling)
│   │   ├── melonbooks.js          # Melonbooks adapter
│   │   ├── registry.js            # store registry (add new stores here)
│   │   └── fixtures/              # sample HTML snapshots (same DOM, placeholder data)
│   ├── matching/matcher.js        # similarity scoring and grading
│   ├── lib/                       # config, text utils, cleaner, site filter, pipeline, cache, settings
│   ├── shared/protocol.js         # message types and status enum
│   └── popup/                     # popup.html / popup.js / popup.css
├── tests/                         # Node tests + six local test pages
├── tools/probe-dlsite.mjs         # online probe: prints URLs, status, parsed items, scores
└── docs/DEVELOPMENT.zh-CN.md      # full Chinese development & measurement notes
```

### Tests

```bash
node --test tests/*.test.js      # 113 tests, no network required
npm test                         # same thing
```

Coverage: title cleaning (including counter-examples that must **not** be over-cleaned), matching thresholds, site filtering, store parsers against the HTML snapshots, the end-to-end pipeline, the card templates, the popup, and the client-side-navigation gate (`tests/content-nav.test.js`).

### Probes against the live stores

```bash
node tools/probe-dlsite.mjs "サンプル作品名"
node tools/probe-dlsite.mjs --title "【サンプル作品】第3話 - 免费漫画 - 示例漫画网"
node tools/probe-dlsite.mjs "キーワード" --raw      # dump the raw HTML to re-calibrate the selectors
```

The probe prints the search URL, HTTP status, the number of parsed items and the top candidates with their scores — so when a store redesigns its site, you can immediately see whether the URL or the selectors broke.

### Local test pages (requirement tests A–F)

`tests/pages/` contains six pages you can open with `file://`; each one states at the top what is expected:

| Test | File | Expectation |
| --- | --- | --- |
| A | `test-a.html` | title + chapter number → the chapter number is stripped, the remaining title is searched |
| B | `test-b.html` | title with 【】, chapter number and site name → all three are cleaned away |
| C | `test-c.html` | a work that does not exist → “not found” + search link, **no product shown** |
| D | `test-d.html` | same cleaning path as A/B, but documents how to reproduce the candidate-list case |
| E | `test-e.html` | adult work → exactly the same flow as an all-ages work |
| F | `test-f.html` | a programming blog → **no card at all**, nothing recommended |

The pages use **sample titles** (they do not name, and are not named after, any real work), so a store search for them returns nothing and the card shows “not found” — which is the expected result. To see a real hit, replace the `<title>` / `og:title` / `h1` in one of those pages with a title you are interested in and reload.

### Test fixtures

`src/stores/fixtures/*.html` are **hand-written sample snapshots** of the store pages: the DOM structure, class names and attributes match the real pages (that is what the parsers are written against), while every product name, product ID, circle name and image URL is placeholder data. They let the store parsers be regression-tested offline.

If you want to check the parsers against a **real** page, save the HTML you fetched into `src/stores/fixtures/local/` — that directory is git-ignored, so real product data never ends up in the repository.

### Packaging a release

```bash
cd .. && zip -qr manga-dlsite-navigator-v0.3.0.zip manga-dlsite-navigator \
  -x "*.DS_Store" "*/node_modules/*"
```

---

## Known limitations

1. **Translated titles are not matched.** The stores index Japanese product names. If all you can see is a Chinese or English translation, the extension shows “not found” plus a manual search link.
2. **Some works are simply not sold there.** Most commercial publisher works (Shueisha, Kodansha, …) are not on DLsite/FANZA/Melonbooks; “not found” is the correct answer.
3. **Very short titles** (fewer than 3 characters) always return zero results on DLsite; the extension falls back to a manual search link.
4. **Matching is deliberately conservative.** Anything below 62 points is hidden, so a query that is only *part* of another product's name shows “not found” rather than a plausible-looking wrong product.
5. **Unusual title formats** where the site name is glued to the work name without any separator may not be cleaned perfectly — again, this ends in “not found”, never in a random guess.
6. **Store redesigns.** Parsing is based on measured HTML and backed by snapshot tests; if a store changes its markup, the adapter reports “search failed” instead of silently claiming “no results”. Re-calibrate with `tools/probe-dlsite.mjs`.
7. **Some networks cannot reach these stores.** In that case the card says the search failed; requests are rate-limited to one per 900 ms and cached for 30 minutes.
8. **Client-side navigation** is detected via `pushState` hooks plus a 0.9 s URL poll, and the extension then waits for the DOM to settle (400 ms quiet, 5 s maximum). On an unusually slow site the first analysis may use the previous content; it re-analyses automatically once the new content lands, and the popup has a manual “Re-analyse” button.
9. **Circle names in brackets** — for a title shaped like `[Circle Name (Author)] Work Title`, the first search variant keeps the bracketed form; the second variant drops it.
10. **Browsers:** Chrome / Chromium first. Edge should work; Firefox would need a `browser.*` shim and a manifest adjustment.

---

## Changelog

**0.3.0**

* Fixed “after opening a new page the extension sometimes doesn't read it” — the popup could show the **previous** page's work. The visible symptom was the gallery site's own homepage tagline being reported as if it were a work title, with “no matching product found”.
  * Root cause: these sites navigate **client-side** (the URL changes, the page is not reloaded, and the content script is not re-created). During that window the URL already points at the new work while the DOM still shows the old page.
  * The content script now has a **navigation gate**: after `pushState` / `popstate` / a URL poll detects a change, it waits until the DOM really swapped (400 ms quiet, 5 s maximum) before reading anything.
  * While the page is settling, page-info requests wait for the new content instead of answering with the old one, and the previous card is removed immediately.
  * New `settled` signal: when `og:url` / `canonical` disagree with the address bar, the page is treated as “still switching” and is never searched.
  * States now carry the id of the document that produced them (`page.scriptId`); the popup reuses a cached state only for the same document, and the background only stores a state if the tab is still on that URL.
* Verified by hand against live pages (see [Verification](#verification)) and covered by 113 tests.

**0.2.2** — site root / listing pages are no longer analysed; navigation-bar text no longer counts as a “work page” signal.

**0.2.1** — the popup discards a cached state that belongs to a different page; in-flight analyses are de-duplicated per tab.

**0.2.0** — added **FANZA** and **Melonbooks** adapters (DLsite → FANZA → Melonbooks, stopping at the first high-confidence hit), FANZA age-check handling through existing browser cookies, per-store verdicts in the popup.

**0.1.x** — title extraction and cleaning (Japanese original preferred, translated-title tags stripped, chapter markers removed), the floating card, the popup, the DLsite adapter and the offline snapshot test suite.

---

## Roadmap

* More stores (BookWalker, Amazon, Kobo, …) — implement `src/stores/store-adapter.js` and register it in `registry.js`.
* Author / circle and ISBN based matching to improve recall.
* Better title cleaning for sites that glue the site name to the work name.
* Optional CJK translation lookup, so translated titles can be matched too.
* Firefox build.

---

## License

Licensed under the **GNU General Public License v3.0** — see [LICENSE](LICENSE).

In short: you are free to use, study, share and modify this code, but derivative works must be released under the same licence and must include the source.

---

## Credits

Built as a personal tool for finding official copies of doujinshi and manga while browsing. Store URLs, HTML structures and behaviours documented in this repository were measured by hand in September 2026; store layouts change, so re-run the probes if something stops working.
