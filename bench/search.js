#!/usr/bin/env node
//
// Relevance benchmark for /food-search.
//
// Ranking changes are easy to get wrong in ways nothing else catches: a syntax check passes, a
// spot check of one query passes, and something three queries away has quietly regressed. This
// records the top result for a fixed set of queries and diffs two runs.
//
// It is what caught the LLM assist failing silently (every call 400ing because the prompts never
// used the word "json", both paths fail-soft so nothing surfaced), and the re-ranker answering
// "big mac" with "Macaroni or noodles with cheese".
//
// Usage:
//   BENCH_SECRET=... node bench/search.js snapshot.json                  # record
//   BENCH_SECRET=... node bench/search.js new.json bench/baseline.json   # record + diff
//
// Env:
//   BENCH_BASE     server to hit           (default http://localhost:8787)
//   BENCH_SECRET   value of API_SECRET     (required if the server enforces it)
//   BENCH_COUNTRY  country code            (default GB)
//
// bench/baseline.json is a known-good snapshot. Re-record it deliberately, only once you have
// read the diff and agree every change is an improvement.
//
// A diff is not automatically a regression. Both upstream sources vary a little between calls, so
// queries where two entries score closely — "cheddar cheese" flips between USDA's "Cheese, Cheddar"
// and an Open Food Facts row — can flap without anything having changed. Judge the diff; a genuine
// regression usually shows as a dish or a snack replacing a plain ingredient.

const fs = require('fs');

const BASE = process.env.BENCH_BASE || 'http://localhost:8787';
// `npm run bench` loads .env, so the server's own API_SECRET is usually already here.
const SECRET = process.env.BENCH_SECRET || process.env.API_SECRET || '';
const COUNTRY = process.env.BENCH_COUNTRY || 'GB';

// Plain ingredients (the case that used to return a dish made from the ingredient), a couple of
// branded/restaurant items, and two misspellings. Add to this whenever a real search disappoints.
const QUERIES = [
  'chicken breast', 'banana', 'rice', 'egg', 'salmon', 'broccoli', 'porridge oats',
  'greek yogurt', 'beef mince', 'milk', 'bread', 'pasta', 'apple', 'avocado', 'tuna',
  'sweet potato', 'almonds', 'cheddar cheese', 'orange juice', 'peanut butter',
  'big mac', 'french fries', 'chikn brest', 'brocoli',
];

async function search(q) {
  const url = `${BASE}/food-search?q=${encodeURIComponent(q)}&country=${encodeURIComponent(COUNTRY)}`;
  // USDA's edge returns intermittent 400s, so a bare failure here would measure luck rather than
  // ranking. Retry, and treat an unfulfilled FDC source as a failure worth retrying too.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'x-api-secret': SECRET } });
      const j = await r.json();
      if (Array.isArray(j.foods) && (j.foods.length || attempt === 3)) {
        if (j.sources && j.sources.fdc !== 'fulfilled' && attempt < 3) throw new Error('fdc unfulfilled');
        return {
          corrected: j.corrected,
          top: j.foods.slice(0, 3).map((f) => ({
            label: (f.brand ? `[${f.brand}] ` : '') + f.name,
            calories: f.calories,
            serving: f.serving,
          })),
        };
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 600 * (attempt + 1)));
  }
  return { top: [] };
}

const describe = (r) => {
  const t = (r && r.top && r.top[0]) || null;
  if (!t) return '(no results)';
  return `${t.label}  —  ${t.calories} cal / ${t.serving}`
    + (r.corrected ? `   [corrected: ${r.corrected}]` : '');
};

(async () => {
  const [outPath, cmpPath] = process.argv.slice(2);
  const results = {};
  for (const q of QUERIES) {
    results[q] = await search(q);
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const prev = cmpPath && fs.existsSync(cmpPath) ? JSON.parse(fs.readFileSync(cmpPath, 'utf8')) : null;
  let changed = 0;
  let empty = 0;

  for (const q of QUERIES) {
    const now = describe(results[q]);
    if (now === '(no results)') empty++;
    if (!prev) { console.log(q.padEnd(16) + now); continue; }
    const was = describe(prev[q]);
    if (was === now) {
      console.log('  =  ' + q.padEnd(16) + now);
    } else {
      changed++;
      console.log(`  ~  ${q.padEnd(16)}\n         was: ${was}\n         now: ${now}`);
    }
  }

  if (prev) console.log(`\n${changed} of ${QUERIES.length} top results changed`);
  if (empty) console.log(`${empty} queries returned nothing — check the server is reachable and BENCH_SECRET is set`);
  // A changed result is not automatically a regression, so this never fails the run. Read the diff.
})();
