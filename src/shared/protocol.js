/**
 * Message protocol and status enums (single source of truth).
 *
 * NOTE: content scripts cannot use ES module imports, so
 * src/content/content.js keeps a copy of the same string constants
 * (marked with a comment there). Keep both in sync when changing values here.
 */

export const MSG = {
  /** content script -> background: report page info and request an analysis */
  ANALYZE_PAGE: 'MN_ANALYZE_PAGE',
  /** popup -> background: read the current state of a tab */
  GET_STATE: 'MN_GET_STATE',
  /** popup -> background: re-analyse the current tab */
  REANALYZE_TAB: 'MN_REANALYZE_TAB',
  /** popup/background -> content script: ask for page info */
  REQUEST_PAGE_INFO: 'MN_REQUEST_PAGE_INFO',
  /** content script -> background: the user clicked "search on DLsite" */
  OPEN_URL: 'MN_OPEN_URL',
  /** popup -> background: read settings */
  GET_SETTINGS: 'MN_GET_SETTINGS',
  /** popup -> background: write settings */
  SET_SETTINGS: 'MN_SET_SETTINGS',
  /** popup -> background: clear the search cache */
  CLEAR_CACHE: 'MN_CLEAR_CACHE',
  /** popup -> background: read the QA capture state (§32 dashboard) */
  QA_GET: 'MN_QA_GET',
  /** popup -> background: change one QA capture (verdict / false positive / note) */
  QA_UPDATE: 'MN_QA_UPDATE',
  /** popup -> background: keep the current page as a test case (§13) */
  QA_CREATE_CASE: 'MN_QA_CREATE_CASE',
  /** popup -> background: build a QA export and hand it back for download (§8) */
  QA_EXPORT: 'MN_QA_EXPORT',
  /** popup -> background: delete every QA capture (§33) */
  QA_CLEAR: 'MN_QA_CLEAR',
  /** background -> content script: state update (optional push) */
  STATE_UPDATED: 'MN_STATE_UPDATED'
};

export const STATUS = {
  /** high-confidence match */
  OK_HIGH: 'ok_high',
  /** possible match (candidates are listed) */
  OK_POSSIBLE: 'ok_possible',
  /** a work was recognised, but the stores returned nothing usable */
  NO_RESULT: 'no_result',
  /** could not recognise a work title (or the page is not a manga page) */
  UNRECOGNIZED: 'unrecognized',
  /** network / parsing failure */
  ERROR: 'error'
};

/** User-facing message texts. The UI language is Chinese, so the values stay Chinese (requirements doc §14). */
export const MESSAGES = {
  READ_FAILED: '无法读取当前页面。',
  TITLE_UNRECOGNIZED: '未能识别作品名称。',
  SEARCH_FAILED: 'DLsite 搜索暂时失败。',
  NO_RESULT: '暂未找到对应商品。',
  NOT_A_COMIC_PAGE: '当前页面不像漫画作品页，暂未自动识别。',
  PAGE_SETTLING: '页面正在切换，等你看到的这一页出现后再识别。'
};
