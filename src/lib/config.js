/**
 * All tunable parameters live here, so thresholds can be adjusted from real
 * measurements (requirements doc §10 / §21).
 */

export const EXTENSION_VERSION = '0.3.0';

export const CONFIG = {
  matcher: {
    /** >= high: reported as "found" */
    high: 85,
    /** >= possible: reported as "possible" and shown with candidates */
    possible: 62,
    /** candidates below this score are never displayed */
    minCandidate: 50,
    /** if the runner-up is this close, the result is treated as a tie */
    tieMargin: 6,
    /** maximum number of candidates to show (requirements doc §14: top 3) */
    maxCandidates: 3,
    /** bonus when a chapter number matches (prefers the same volume/episode) */
    chapterHintBonus: 5
  },
  cache: {
    /** cache lifetime for hits (requirements doc §18: 10–30 minutes) */
    positiveTtlMs: 30 * 60 * 1000,
    /** cache lifetime for "not found" — short, so newly listed works show up quickly */
    negativeTtlMs: 5 * 60 * 1000,
    /** maximum number of cache entries */
    maxEntries: 200
  },
  search: {
    /** measured on DLsite: keywords shorter than 3 characters always return 0 results */
    minQueryLength: 3,
    /** maximum number of search variants kept per title */
    maxQueries: 3,
    /** how many variants to actually search (a subtitle/English title case needs 2) */
    maxVariantsToSearch: 2,
    /** stores other than DLsite are searched once with the main variant only, to limit requests */
    maxVariantsForExtraStores: 1,
    /** per-request timeout */
    timeoutMs: 12000,
    /** minimum delay between store requests, to stay polite */
    minIntervalMs: 900,
    /** maximum number of candidates merged per analysis */
    maxItemsTotal: 90,
    /** maximum items taken from one section (DLsite shows 30 per page) */
    maxItemsPerStep: 30
  },
  stores: {
    /** search order: DLsite first, then FANZA / Melonbooks when nothing is convincing (requirements doc §23) */
    enabled: ['dlsite', 'fanza', 'melonbooks']
  },
  extractor: {
    /** how much page text to sample (used to decide "is this a manga page?") */
    textSampleLength: 2000,
    /** how often to poll for URL changes on client-side navigations */
    urlPollMs: 900,
    /** after a client-side navigation, how long the DOM must stay quiet to count as "the new page is ready" */
    settleQuietMs: 400,
    /** maximum wait for a client-side navigation (after that we analyse whatever is on screen) */
    settleMaxWaitMs: 5000,
    /** maximum time the popup waits for the new page to become ready */
    popupWaitMs: 8000
  },
  defaults: {
    /** master switch */
    enabled: true,
    /** show the floating card automatically once a work is recognised */
    autoShowCard: true,
    /** debug: use the bundled store snapshots instead of the network */
    mockMode: false,
    /** debug: skip the "is this a manga page?" check */
    ignoreSiteFilter: false
  }
};

/**
 * Sites that can never host a manga work page. The extension exits silently
 * there, so a wrong recommendation is never shown (requirements doc §20 test F).
 */
export const DENY_HOSTS = [
  'dlsite.com',
  'google.com',
  'google.com.hk',
  'google.co.jp',
  'bing.com',
  'baidu.com',
  'duckduckgo.com',
  'yandex.com',
  'sogou.com',
  'so.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'weibo.com',
  'reddit.com',
  'zhihu.com',
  'douban.com',
  'tieba.baidu.com',
  'youtube.com',
  'youtu.be',
  'bilibili.com',
  'nicovideo.jp',
  'netflix.com',
  'twitch.tv',
  'amazon.com',
  'amazon.co.jp',
  'taobao.com',
  'tmall.com',
  'jd.com',
  'ebay.com',
  'rakuten.co.jp',
  'github.com',
  'gitlab.com',
  'stackoverflow.com',
  'developer.mozilla.org',
  'wikipedia.org',
  'wikimedia.org',
  'notion.so',
  'docs.google.com',
  'mail.google.com',
  'outlook.com',
  'chatgpt.com',
  'chat.openai.com',
  'openai.com',
  'claude.ai',
  'localhost'
];

/** Pages matching these URL shapes are skipped as well */
export const DENY_URL_PATTERNS = [
  /^\w+:\/\/(?:www\.)?google\.[a-z.]+\/search/i,
  /^\w+:\/\/(?:www\.)?bing\.com\/search/i,
  /^\w+:\/\/(?:www\.)?baidu\.com\/s/i,
  /\/search\?/i,
  /^chrome(-extension)?:\/\//i,
  /^about:/i,
  /^devtools:\/\//i
];

/**
 * Signals that a page is a manga page (requirements doc §7 / §20 test F).
 * A page is analysed only if one strong signal, or two normal signals, hit.
 */
export const STRONG_PAGE_SIGNALS = [
  /** a chapter marker in the title or body text */
  /第\s*\d{1,4}\s*[話话回巻卷集章]/,
  /(?:chapter|episode|ep|vol|volume)\.?\s*\d{1,4}/i
];

export const NORMAL_PAGE_SIGNALS = [
  /漫画|漫畫|マンガ|コミック|comic|manga|manhua|manhwa/i,
  /連載|连载|全巻|全卷|話|话|巻|巻數|在线阅读|在线观看|免費|免费|汉化|漢化|生肉|raw/i,
  /試し読み|立ち読み|ネタバレ|同人|成人向け|R-?18/i
];

/** Hosts containing one of these words are treated as likely manga sites */
export const MANGA_HOST_HINTS = [
  'manga', 'comic', 'manhua', 'manhwa', 'dongman', 'dm5', 'copymanga',
  'baozimh', 'manhuagui', 'kox', 'mangacopy', 'mangacat', 'yymanhua',
  'cartoon', 'acg', 'comiket', 'doujin',
  // doujinshi gallery sites (a work page = title + a Tags/Groups/Languages/Pages info block)
  'nhentai', 'hentai', 'e-hentai', 'exhentai', 'hitomi', 'asmhentai',
  '18comic', 'jmcomic', 'wnacg', 'tsumino', 'pururin'
];

/**
 * Structural markers of a gallery-style work page.
 * Some gallery sites list Tags / Groups / Languages / Pages fields in an info
 * block; ordinary blogs and news pages do not, which makes it a good
 * discriminator between "work page" and "ordinary web page".
 */
export const GALLERY_PAGE_SIGNALS = [
  /\bparodies\s*[:：]/i,
  /\b(?:tags|groups?|languages?|categories|category|pages|artists?|circles?|characters?|uploaded|favorites?)\s*[:：]/i,
  /\bpages\s*[:：]\s*\d+/i,
  /\b\d+\s*(?:pages|ページ)\b/i,
  /原作\s*[:：]/, /サークル\s*[:：]/, /作者\s*[:：]/, /タグ\s*[:：]/,
  /ジャンル\s*[:：]/, /ページ数\s*[:：]/, /収録\s*[:：]/
];

/** URL shapes that look like a work detail page */
export const DETAIL_URL_PATTERN = /\/(?:g|gallery|galleries|view|work|works|comic|comics|manga|book|books|read|chapter|ch|ep|episode|detail|p|post)\/[^/?#]+/i;
