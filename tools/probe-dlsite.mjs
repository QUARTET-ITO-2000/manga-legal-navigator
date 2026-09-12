#!/usr/bin/env node
/**
 * DLsite probe (requirements doc §29).
 *
 * This was the original one-store probe; it has been generalised into
 * tools/probe-store.mjs. The file stays because the README and older notes
 * point at it, and it keeps the same flags:
 *
 *   node tools/probe-dlsite.mjs "サンプル作品名"
 *   node tools/probe-dlsite.mjs --title "【サンプル作品】第3話 - 免费漫画 - 示例漫画网"
 *   node tools/probe-dlsite.mjs "キーワード" --raw
 *
 * Anything it can do, `node tools/probe-store.mjs --store dlsite …` can do too
 * (plus --store fanza / melonbooks / pixiv / fantia, --all and --json).
 */

import { runProbeCli } from './probe-store.mjs';

runProbeCli({ store: 'dlsite' }).catch((error) => {
  console.error(error);
  process.exit(1);
});
