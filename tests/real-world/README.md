# Real-world test set (QA phase)

This directory is the committed half of the QA workflow described in the
requirements document (§13–§16, §26–§28, §36).

```text
tests/real-world/
├── extraction/    page recognition + title extraction
├── cleaning/      title cleaning (chapter numbers, site names, brackets …)
├── matching/      similar works: 完全版 / 総集編 / 第1巻 vs 第2巻
├── navigation/    SPA / pushState / dynamic title
├── store/         one case per store adapter (incl. fallback order)
├── performance/   request budget + cache behaviour
└── negative/      pages that must not trigger a store request
```

## What a case file contains

Only structure and expectation — never a real title, never a real URL:

```json
{
  "id": "RW-001",
  "category": "static-gallery",
  "features": { "pageType": "gallery", "h1": true, "ogTitle": true, "jsonLd": false,
                "galleryInfo": true, "manyImages": true, "spaNavigation": false },
  "expected": { "pageRecognition": true, "storeSearch": true, "correctMatch": true,
                "cleanedTitle": "<the title the cleaner should produce>", "maxRequests": 1 },
  "fixture": { "pageInfo": { "…": "placeholder page summary" } }
}
```

`fixture.pageInfo` is optional. It lets the case run offline against the store
snapshots in `src/stores/fixtures/`, so the suite is repeatable in CI. Cases
created from a real page via `[Create Test Case]` instead carry their page
summary in `qa/captures/<id>.json` (git-ignored, real data).

## Expected fields

| field | meaning |
| --- | --- |
| `pageRecognition` | should the page be treated as a work page? |
| `storeSearch` | should a store search be triggered? |
| `correctMatch` | should a product be recommended? |
| `grade` | `found` / `possible` / `none` — the grade the pipeline must produce |
| `cleanedTitle` | the exact title the cleaner should produce |
| `maxRequests` | tighter request budget than the global one (requirements doc §23) |
| `limitation` | a known, accepted limitation — the case is reported as `EXPECTED_LIMITATION` |

## Running

```bash
node tools/qa-run.mjs              # offline replay against the committed snapshots
node tools/qa-run.mjs --live       # replay against the real stores (one pass, no crawl)
node tools/qa-run.mjs --category negative
```

Results are written to `qa/results-latest.json`; failures additionally appear as
`qa/failures/FAIL-xxx.json` after `node tools/qa-report.mjs`.

## Files that must stay out of git

* `tests/sites.local.json` — the real urls (requirements doc §13)
* `qa/` — captures, results, summaries and failure bundles

Both are listed in `.gitignore`. `tools/qa-import.mjs` writes them for you.
