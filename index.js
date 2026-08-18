// Food Swap — app-owned transcription + vision backend.
// =============================================================================
// Holds the OpenAI key SERVER-SIDE so it never ships inside the mobile app bundle.
// The app calls these two endpoints; this server forwards to OpenAI with the secret key.
//
//   POST /transcribe   multipart/form-data, field "audio"   → { transcript }   (Whisper)
//   POST /vision       JSON { base64, mime }                → { analysis }      (gpt-4o vision)
//   GET  /health                                            → { ok: true }
//
// Run:
//   cd server && npm install
//   OPENAI_API_KEY=sk-... npm start        (listens on :8787)
//
// Then point the app at it (use your Mac's LAN IP so the iPhone can reach it) — see .env.example:
//   EXPO_PUBLIC_VOICE_ENDPOINT=http://<mac-ip>:8787/transcribe
//   EXPO_PUBLIC_VISION_ENDPOINT=http://<mac-ip>:8787/vision
//
// Requires Node 18+ (global fetch / FormData / Blob).
const express = require('express');
const multer = require('multer');

const PORT = process.env.PORT || 8787;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
// Optional shared secret. When set (e.g. on a public cloud host) the app must send it in the
// `x-api-secret` header or requests are rejected — stops strangers burning your OpenAI key. Leave
// unset for local LAN dev (no auth).
const API_SECRET = process.env.API_SECRET || '';
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';     // or 'gpt-4o-transcribe'
const VISION_MODEL = process.env.VISION_MODEL || 'gpt-4o';   // configurable; gpt-4.1-mini / gpt-4o-mini only if cost requires

// Keep in sync with src/prompts/vision-analysis.ts so the JSON matches FoodPhotoAnalysis.
const VISION_SYSTEM = `You are a food photo analysis engine for a nutrition coaching app.

Your job is to analyse a meal photo by identifying every visible food item individually, estimating portions, and calculating nutrition.

You must be specific.

Do not collapse visible ingredients into generic categories.

Bad examples:
- vegetables
- carbs
- protein
- dressing/oil estimate
- mixed meal
- bowl
- salad
- rice
- meat
unless that is truly the only identifiable description.

Good examples:
- grilled chicken breast
- scrambled eggs
- sautéed mushrooms
- roasted pumpkin
- grilled tomato
- Caesar dressing
- avocado
- white rice
- feta cheese

Critical rule:
Do not calculate total nutrition until you have first identified every visible component separately.

Analyse the image in this order:
1. Identify visible food items.
2. For each item, describe the visual evidence.
3. Estimate portion size using plate size, ramekins, utensils, hand/object scale if visible, relative area, and food thickness.
4. Estimate grams or household measure.
5. Check for common confusions:
   - scrambled eggs vs rice
   - pumpkin vs sweet potato
   - mushrooms vs beef
   - sauce vs oil
   - avocado vs cucumber
   - chicken breast vs fish
   - noodles vs cabbage
   - cheese vs egg
   - cream sauce vs yoghurt dressing
6. Estimate calories/macros per item.
7. Sum totals into "original".
8. Assign confidence per item and overall.

If unsure, do not guess confidently. Provide possible_alternatives and lower confidence.
If a food is partly hidden, estimate conservatively and mark lower confidence.
If a sauce/dressing is visible in a ramekin, treat it as a separate item. Do not merge it into oil.
If the image quality is insufficient, set needs_clarification to true.

Never provide coaching advice or meal swaps. Never return 0 calories for a visible meal.
"original" is the whole-meal estimate and must equal the sum of the components.
confidence_label must be one of: "High confidence estimate", "Estimate needs review", "Low confidence estimate".

Return JSON only. No markdown. No commentary. Use exactly this shape:

{
  "meal_name": "",
  "overall_confidence": 0.0,
  "confidence_label": "",
  "original": { "name": "", "portion": "", "calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0, "confidence": 0.0 },
  "components": [
    {
      "name": "",
      "visual_evidence": "",
      "portion": "",
      "estimated_grams": 0,
      "calories": 0,
      "protein_g": 0,
      "carbs_g": 0,
      "fat_g": 0,
      "confidence": 0.0,
      "possible_alternatives": [],
      "needs_user_confirmation": false
    }
  ],
  "possible_missed_items": [ { "name": "", "reason": "", "confidence": 0.0 } ],
  "assumptions": [],
  "needs_clarification": false,
  "clarifying_question": null
}`;

const app = express();
// CORS — the app runs from a browser (Expo web / Claude preview) on a different origin than this
// proxy, so without these headers the browser blocks every /vision /menu /transcribe fetch and the
// app silently falls back to "couldn't reach the food service". Native (iOS/Android) isn't subject
// to CORS, but sending these is harmless there. Permissive by design — this is a local dev proxy.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, x-api-secret');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '25mb' }));
// Shared-secret gate (only active when API_SECRET is set). /health stays open for uptime checks.
app.use((req, res, next) => {
  if (!API_SECRET || req.path === '/health') return next();
  if (req.headers['x-api-secret'] === API_SECRET) return next();
  return res.status(401).json({ error: 'unauthorized' });
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function keyMissing(res) {
  if (!OPENAI_API_KEY) { res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server' }); return true; }
  return false;
}

app.get('/health', (_req, res) => res.json({ ok: true, hasKey: !!OPENAI_API_KEY }));

// ── Transcription (Whisper-quality, server-side) ─────────────────────────────
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (keyMissing(res)) return;
  try {
    if (!req.file) return res.status(400).json({ error: 'no audio file (field "audio")' });
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/m4a' }), req.file.originalname || 'meal.m4a');
    form.append('model', TRANSCRIBE_MODEL);
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    if (!r.ok) return res.status(502).json({ error: `transcription failed (${r.status})` });
    const data = await r.json();
    res.json({ transcript: (data.text || '').trim() });
  } catch (e) {
    res.status(500).json({ error: 'transcription error' });
  }
});

// ── Vision (photo → structured meal JSON, server-side) ───────────────────────
app.post('/vision', async (req, res) => {
  if (keyMissing(res)) return;
  try {
    const { base64, mime, correction, previous } = req.body || {};
    // A correction ("that bread is a beef patty") may arrive without the photo — an older meal can
    // still be re-estimated from the previous analysis alone.
    if (!base64 && !correction) return res.status(400).json({ error: 'no image (base64)' });
    const userText = correction
      ? [
          'Analyse this meal. Identify every visible food item separately, then return ONLY the JSON object.',
          '',
          'The user says a previous analysis was WRONG. Their correction:',
          `"${String(correction).trim()}"`,
          previous ? `\nThe analysis to correct:\n${JSON.stringify(previous)}` : '',
          '',
          'Apply the correction and re-estimate. Treat the user as the authority on WHAT the food is —',
          "if they rename an item, replace it and recalculate that item's calories and macros from scratch.",
          'Keep everything they did not mention.',
        ].join('\n')
      : 'Analyse this meal photo. Identify every visible food item separately, then return ONLY the JSON object.';
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: Number(process.env.VISION_MAX_TOKENS) || 2000,
        temperature: 0,   // deterministic → the same photo returns the same calories/macros (Log == Swap)
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: VISION_SYSTEM },
          { role: 'user', content: [
            { type: 'text', text: userText },
            ...(base64 ? [{ type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${base64}`, detail: 'high' } }] : []),
          ] },
        ],
      }),
    });
    if (!r.ok) return res.status(502).json({ error: `vision failed (${r.status})` });
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content || '{}';
    let analysis;
    try { analysis = JSON.parse(text); } catch { return res.status(502).json({ error: 'vision parse error' }); }
    res.json({ analysis });
  } catch (e) {
    res.status(500).json({ error: 'vision error' });
  }
});

// ── Food search (USDA FoodData Central) ──────────────────────────────────────
// GET /food-search?q=chicken → { foods: [{ name, brand, serving, calories, protein, carbs, fats }] }
// Free API; set FDC_API_KEY for higher rate limits (DEMO_KEY works for light testing).
const FDC_API_KEY = process.env.FDC_API_KEY || 'DEMO_KEY';

// ── Serving sizes ────────────────────────────────────────────────────────────
// Both sources give nutrition PER 100 g, but each also carries a serving label that usually isn't
// 100 g ("56 g", "1 burger (219 g)"). Pairing the two without scaling reported a Big Mac as 261 cal
// — technically the per-100g figure, but presented against a whole burger. In a calorie tracker
// that is not a cosmetic problem, so nutrition is scaled to whatever serving we display.
//
// ml is treated as g. Wrong for oils, close enough for the drinks this actually hits, and far
// closer than showing a 100 ml figure against a 330 ml can.
const SERVING_G = /(\d+(?:\.\d+)?)\s*(g|gram|grams|ml|millilitre|milliliter)\b/i;

function servingGrams(label) {
  const m = String(label || '').match(SERVING_G);
  if (!m) return null;
  const n = Number(m[1]);
  // Sanity bounds: below ~4 g it's a spice measure that would round everything to zero; above
  // 1500 g it's a catering pack, not a serving.
  return Number.isFinite(n) && n >= 4 && n <= 1500 ? n : null;
}

/** Scale a per-100g food onto its real serving, so the numbers match the label beside them. */
function perServing(food) {
  // A weight already resolved from USDA's portion table wins: it came from a structured gramWeight
  // rather than a string, so it never depends on the label parsing cleanly.
  const grams = food.servingGrams || servingGrams(food.serving);
  if (!grams) return { ...food, serving: '100 g' };   // no usable weight: be honest, say 100 g
  const k = grams / 100;
  return {
    ...food,
    serving: String(food.serving).trim(),
    servingGrams: grams,
    calories: Math.round(food.calories * k),
    protein: Math.round(food.protein * k),
    carbs: Math.round(food.carbs * k),
    fats: Math.round(food.fats * k),
  };
}

function fdcNutrient(food, id) {
  const n = (food.foodNutrients || []).find((x) => (x.nutrientId ?? x.nutrient?.id) === id);
  const v = n?.value ?? n?.amount ?? 0;
  return typeof v === 'number' && isFinite(v) ? v : 0;
}
function normalizeFdcFood(food) {
  const name = String(food.description || '').trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const brand = String(food.brandName || food.brandOwner || '').trim();
  const serving = food.servingSize ? `${Math.round(food.servingSize)} ${String(food.servingSizeUnit || 'g').toLowerCase()}` : '100 g';
  return {
    name: name.length > 60 ? name.slice(0, 60) : name,
    brand,
    // Foundation / SR Legacy are USDA's curated generic foods; Branded is packaged products.
    curated: /Foundation|SR Legacy|Survey/i.test(String(food.dataType || '')),
    fdcId: food.fdcId,   // kept so the page of results can be enriched with household portions
    serving,
    calories: Math.round(fdcNutrient(food, 1008)),   // Energy (kcal)
    protein: Math.round(fdcNutrient(food, 1003)),    // Protein
    carbs: Math.round(fdcNutrient(food, 1005)),      // Carbohydrate
    fats: Math.round(fdcNutrient(food, 1004)),       // Total lipid (fat)
  };
}
// ── Household portions ───────────────────────────────────────────────────────
// USDA's curated foods carry no servingSize, so they were all reported as "100 g" — technically
// true and practically useless, because nobody logs 100 g of Big Mac. The gram weight of a real
// portion ("1 McDonald's Big Mac = 205 g", "1 banana = 140 g") does exist, but only on the detail
// endpoint, which search never returned: `foodPortions` comes back empty in search results.
//
// So the page of results is enriched afterwards. POST /fdc/v1/foods takes a list of ids, which
// means one extra request for the whole page rather than one per food.
const PORTION_CACHE = new Map();      // fdcId -> {desc, g} | null  (null = looked up, has none)
const PORTION_CACHE_MAX = 2000;

// "1 oz, raw, yields" and "per surface inch of pizza" are analytical measures, not servings.
const PORTION_SKIP = /\byields\b|per surface|per cubic/i;
const QNS = /quantity not specified/i;

// Which label reads best when several portions weigh the same. "1 medium breast" beats "1 breast,
// NS as to size" (USDA's internal wording), which beats "1 cup, cooked, diced" (a measure of a
// processed form rather than the item itself).
function labelRank(desc) {
  if (/\bNS as to\b/i.test(desc)) return 3;
  if (/\b(cup|oz|tbsp|tsp|slice|linear inch|mashed|diced|chopped|shredded)\b/i.test(desc)) return 2;
  return 1;
}

// Sanity bounds, as in servingGrams: under ~4 g every macro rounds to zero, over 1500 g it's a
// catering pack rather than a portion.
const inBounds = (g) => g >= 4 && g <= 1500;

/** The portion most like something a person would actually eat, or null.
 *
 *  The ordering USDA returns is NOT the sequence order, and the first entry is often wrong for our
 *  purposes: for "Banana, raw" it is "1 cup, mashed". What is reliable is the "Quantity not
 *  specified" row — despite the name it holds the weight typically eaten (banana 126 g, french
 *  fries 110 g, Big Mac 205 g), which is exactly the serving we want. Its label is useless though,
 *  so it picks the weight and a same-weight named portion supplies the words. */
function bestPortion(portions) {
  const all = (portions || [])
    .map((p) => ({
      desc: String(p.portionDescription || p.modifier || '').trim(),
      g: Number(p.gramWeight),
      seq: Number(p.sequenceNumber) || 999,
    }))
    .filter((p) => p.desc && Number.isFinite(p.g) && p.g > 0);

  const named = all.filter((p) => !QNS.test(p.desc) && !PORTION_SKIP.test(p.desc) && inBounds(p.g));
  const typical = all.find((p) => QNS.test(p.desc));

  if (typical && inBounds(typical.g)) {
    const match = named
      .filter((p) => Math.abs(p.g - typical.g) <= Math.max(1, typical.g * 0.02))
      .sort((a, b) => labelRank(a.desc) - labelRank(b.desc) || a.seq - b.seq)[0];
    // Nothing named matches the typical weight (chips and fries come only as single pieces), so
    // report the honest weight under a neutral label rather than logging someone a single chip.
    return match ? { desc: match.desc, g: match.g } : { desc: '1 serving', g: typical.g };
  }

  // No typical weight: fall back to USDA's own canonical ordering.
  const first = named.sort((a, b) => a.seq - b.seq)[0];
  return first ? { desc: first.desc, g: first.g } : null;
}

async function fetchPortions(ids) {
  const url = `https://api.nal.usda.gov/fdc/v1/foods?api_key=${FDC_API_KEY}`;
  // Same nginx flakiness the search call has to defend against.
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fdcIds: ids, format: 'full' }),
    });
    if (r.ok) {
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    }
    await new Promise((done) => setTimeout(done, 250 * (i + 1)));
  }
  throw new Error('fdc portions unavailable');
}

/** Replace "100 g" with a real portion wherever USDA knows one. Never throws: a food with no
 *  portion, or an outage on this second call, simply keeps the per-100g figure it already had. */
async function withPortions(foods) {
  const wanted = foods
    .filter((f) => f.source === 'fdc' && f.fdcId && f.serving === '100 g')
    .map((f) => f.fdcId);
  const missing = [...new Set(wanted)].filter((id) => !PORTION_CACHE.has(id));

  if (missing.length) {
    try {
      for (const food of await fetchPortions(missing)) {
        if (PORTION_CACHE.size >= PORTION_CACHE_MAX) PORTION_CACHE.clear();
        PORTION_CACHE.set(food.fdcId, bestPortion(food.foodPortions));
      }
      // Anything the response omitted is cached as "none" so it isn't re-requested every search.
      for (const id of missing) if (!PORTION_CACHE.has(id)) PORTION_CACHE.set(id, null);
    } catch {
      return foods;   // portions are an enhancement; losing them must not lose the search
    }
  }

  return foods.map((f) => {
    const p = f.fdcId && f.serving === '100 g' ? PORTION_CACHE.get(f.fdcId) : null;
    if (!p) return f;
    // servingGrams is what perServing scales by; the label is only what the user reads.
    return { ...f, serving: `${p.desc} (${Math.round(p.g)} g)`, servingGrams: p.g };
  });
}

// ── Open Food Facts (text search) ────────────────────────────────────────────
// USDA's branded catalogue is US packaged goods, which is close to useless for UK shoppers looking
// for Tesco / Sainsbury's / Greggs. OFF has ~3M products with strong UK+EU coverage and needs no
// key. We already used it for barcode lookups; this puts it behind text search too.
const OFF_FIELDS = 'product_name,brands,nutriments,serving_size,countries_tags';
const OFF_UA = { 'User-Agent': 'Nudge/1.0 (nutrition app)' };

// The app stores ISO-2 country codes (see src/data/options.ts) but OFF filters on slugs, so
// `country=us` matched nothing until this mapping existed. Accept either form.
const OFF_COUNTRY = {
  US: 'united-states', GB: 'united-kingdom', AU: 'australia',
  CA: 'canada', NZ: 'new-zealand', IE: 'ireland',
};
const HOME_OF_FDC = 'united-states';   // USDA *is* the US packaged-goods database

function offCountry(c) {
  if (!c) return '';
  const up = String(c).trim().toUpperCase();
  if (OFF_COUNTRY[up]) return OFF_COUNTRY[up];
  if (up === 'OTHER') return '';
  return String(c).trim().toLowerCase().replace(/\s+/g, '-');
}

// Two OFF endpoints, deliberately in this order. Measured against real queries:
//   - legacy cgi/search.pl has much the best relevance ("tesco hummus" -> actual hummus) but 503s
//     intermittently under load.
//   - search.openfoodfacts.org (search-a-licious) is fast and reliable but looser on relevance
//     ("tesco hummus" -> peppers and salad), so it is the fallback rather than the default.
//   - the v2 /api/v2/search endpoint ignores search_terms entirely and is unusable for text search.
async function searchOpenFoodFacts(q, country, page = 1) {
  const legacy = 'https://world.openfoodfacts.org/cgi/search.pl'
    + `?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1`
    + `&page_size=50&fields=${OFF_FIELDS}`
    + (country ? `&tagtype_0=countries&tag_contains_0=contains&tag_0=${encodeURIComponent(country)}` : '');
  for (let i = 0; i < 2; i++) {                      // one quick retry absorbs most 503s
    try {
      const r = await fetch(legacy, { headers: OFF_UA });
      if (r.ok) {
        const d = await r.json();
        const out = (Array.isArray(d.products) ? d.products : []).map(normalizeOffFood).filter(Boolean);
        if (out.length) return out;
      }
    } catch { /* fall through */ }
  }
  try {
    const alt = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}`
      + `&page_size=50&fields=${OFF_FIELDS}`;
    const r = await fetch(alt, { headers: OFF_UA });
    if (!r.ok) return [];
    const d = await r.json();
    return (Array.isArray(d.hits) ? d.hits : []).map(normalizeOffFood).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeOffFood(p) {
  const name = String(p.product_name || '').trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const n = p.nutriments || {};
  // OFF gives per-100g under `_100g`. Prefer kcal; fall back to converting kJ.
  const kcal = Number(n['energy-kcal_100g']) || (Number(n.energy_100g) ? Number(n.energy_100g) / 4.184 : 0);
  if (!kcal || !isFinite(kcal)) return null;
  // cgi returns brands as a comma string, search-a-licious as an array.
  const brand = (Array.isArray(p.brands) ? p.brands[0] : String(p.brands || '').split(',')[0] || '').trim();
  return {
    name: name.length > 60 ? name.slice(0, 60) : name,
    brand,
    serving: String(p.serving_size || '').trim() || '100 g',
    calories: Math.round(kcal),
    protein: Math.round(Number(n.proteins_100g) || 0),
    carbs: Math.round(Number(n.carbohydrates_100g) || 0),
    fats: Math.round(Number(n.fat_100g) || 0),
    source: 'off',
  };
}

// USDA returns results in an order that buries the obvious answer: "chicken" puts obscure entries
// above "Chicken, breast". Score by how well the name actually matches what was typed.
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Someone typing an ingredient wants the ingredient, not a dish built from it. Left alone, every
// base food lost to a composed one — "egg" returned Egg burrito, "salmon" returned Salmon salad,
// "peanut butter" returned Peanut butter sandwich — because a dish name starts with the ingredient
// and so banks the full prefix bonus. These are the forms a food gets turned into; the list is
// USDA-wide vocabulary rather than anything per-food.
const DISH_WORDS = /\b(salad|sandwich|burrito|taco|wrap|soup|stew|casserole|pie|cake|patty|patties|roll|spread|sauce|gravy|dessert|smoothie|shake|pizza|curry|omelet|omelette|quiche|fritter|nugget|nuggets|tender|tenders|dinner|entree|babyfood|baby food|crackers|bagel|bagels|candies|candy|supplement|lunchmeat|deli|prepackaged|breaded|battered|canned|dip|pudding|custard|topping|filling|bar|bars|snack|snacks|mix|powder|concentrate|stick|sticks|crumbs|chips|stuffing|pretzel|cereal)\b/i;

// Preparations that make a food something more specific than what was asked for. Milder than
// DISH_WORDS: a fried egg is still an egg, so this only breaks ties.
const PREP_WORDS = /\b(fried|glazed|seasoned|flavor|flavored|flavour|flavoured|smoked|pickled|marinated|stuffed|coated|creamed|sweetened|reduced fat|fat-free|low fat|light|fruit|honey|vanilla|chocolate|strawberry)\b/i;

// USDA's own markers for "the plain, unqualified version of this food". NFS = Not Further
// Specified, NS = Not Specified — these are deliberate editorial markers and mean exactly what we
// want, so they score strongly.
const GENERIC_STRONG = /\bNFS\b|\bNS as to\b/i;
// "raw" and "plain" only suggest it. They are ordinary words that also appear in things like
// "Bread, sticks, plain", so scoring them as highly as NFS put a breadstick above a loaf.
const GENERIC_WEAK = /\braw\b|\bplain\b/i;

/** Words present in the food's name that the user did not ask for. Used so a penalty only applies
 *  when the extra term is genuinely unwanted — searching "salmon salad" must still find one. */
function unaskedMatch(re, name, query) {
  const m = name.match(re);
  return m ? !query.includes(m[0].toLowerCase()) : false;
}

function scoreFood(f, q, country) {
  const query = q.toLowerCase().trim();
  const name = f.name.toLowerCase();
  const brand = (f.brand || '').toLowerCase();
  const hay = `${brand} ${name}`.trim();
  const words = query.split(/\s+/).filter(Boolean);
  let s = 0;

  // How much of what they typed does this actually contain? Checked across brand AND name so
  // "tesco hummus" and "greggs sausage roll" find the retailer's own product. This gates everything
  // else: without it, category bonuses float items with no textual relevance at all to the top.
  const cover = words.filter((w) => hay.includes(w)).length / words.length;
  if (cover < 0.5) return -1000;               // matches less than half the query, not a real result
  // A one-word query names a food, not a brand. Without this, searching "chicken" returns CHUNK
  // LIGHT TUNA because its brand is "Chicken of the Sea".
  if (words.length === 1 && !name.includes(query)) return -1000;
  // The NAME must carry at least one query word. Matching on brand alone let "tesco hummus" return
  // "[Tesco] Avocado" -- right shop, entirely the wrong food.
  if (!words.some((w) => name.includes(w))) return -1000;
  s += cover * 40;

  // Exact match matters but must NOT dominate. USDA branded rows are literally named "BANANA" and
  // "CHICKEN BREAST", so an overweighted exact bonus floats a peanut-butter product above the fruit.
  if (name === query) s += 70;
  else if (name.startsWith(query)) s += 60;
  else if (new RegExp(`\\b${escRe(query)}`).test(name)) s += 35;
  else if (name.includes(query)) s += 15;

  // Where in the name the match lands matters more than whether the exact phrase appears, because
  // USDA inverts its canonical names: "Cheese, Cheddar" never contains the phrase "cheddar cheese",
  // while "Snacks, M&M MARS, COMBOS Snacks Cheddar Cheese Pretzel" does — and so won on the phrase
  // bonus above. USDA puts the food first and qualifies it afterwards, so a match inside the
  // opening segments is the subject of the entry; a match in a trailing segment is an ingredient
  // or flavour of something else.
  const segments = name.split(',').map((x) => x.trim());
  const inFirst = words.every((w) => (segments[0] || '').includes(w));
  const inHead = words.every((w) => segments.slice(0, 2).join(' ').includes(w));
  if (inFirst) s += 55;
  else if (inHead) s += 40;

  // Is this a product the user can actually buy? OFF is country-filtered upstream, so outside the
  // US only OFF rows are local; inside the US both sources are.
  const local = !country || country === HOME_OF_FDC || f.source === 'off';

  // Did the user actually name a brand? Only count a brand hit on a word the NAME doesn't already
  // contain, otherwise "HAPPY HUMMUS" scores as if it were the retailer that was asked for.
  const brandAsked = words.length > 1 && brand
    && words.some((w) => w.length > 2 && brand.includes(w) && !name.includes(w));
  if (brandAsked) s += 60;                       // naming a brand is a strong intent signal
  else if (brand) s -= local ? 12 : 50;          // unasked brand: mild if buyable, heavy if foreign
  else s += 30;                                  // generic whole food

  // The strongest signal available for a generic query, and the one that was missing: USDA marks
  // its curated generic foods as Foundation / SR Legacy. Those are the canonical entries ("Bananas,
  // raw"), whereas Branded rows are packaged goods whose terse names ("BANANA") exact-match a plain
  // query while being something else entirely, e.g. a 467 kcal yogurt-covered snack.
  // Raised from 45. USDA's canonical entries carry taxonomic names ("Chicken, broilers or fryers,
  // breast, meat only, raw") which never match the typed phrase, while a supermarket row named
  // exactly "Chicken breast" banks the full exact-match bonus. Searching "chicken breast" therefore
  // returned Coles and Tesco ahead of the generic food. The bonus has to exceed that exact-match
  // advantage for the canonical entry to lead — but it stays behind brandAsked, so typing a brand
  // still finds the brand.
  if (!brandAsked && f.curated) s += 80;

  // USDA marks its canonical generic entries NFS / "NS as to" / raw / plain. Without this a bare
  // "greek yogurt" returns "Yogurt, Greek, with oats" over plain Greek yogurt, since a flavoured
  // variant matches the query just as well.
  if (!brandAsked && GENERIC_STRONG.test(f.name)) s += 45;
  else if (!brandAsked && GENERIC_WEAK.test(f.name)) s += 15;

  // A dish made from the food is not the food. Only counts when the user did not name the dish, so
  // "salmon salad" still finds one. This is the single biggest correction: without it "egg" is an
  // Egg burrito and "peanut butter" is a sandwich.
  if (unaskedMatch(DISH_WORDS, name, query)) s -= 70;
  if (unaskedMatch(PREP_WORDS, name, query)) s -= 25;

  if (country === HOME_OF_FDC && f.source === 'fdc') s += 8;
  else if (country && country !== HOME_OF_FDC && f.source === 'off') s += 30;

  // Was `name.length / 6`, which decided every tie between FNDDS variants by which name happened to
  // be shortest — that is how "Chicken breast, roll, oven-roasted" (34 chars) beat "Chicken breast,
  // grilled without sauce, skin not eaten" (52). Length carries no nutritional meaning. What does
  // is how many qualifiers USDA had to add to describe the food: fewer means closer to the plain
  // ingredient. Capped so a verbose branded string can't be pushed below a genuinely worse match.
  s -= Math.min(12, (name.split(',').length - 1) * 4);
  if (f.protein || f.carbs || f.fats) s += 5;  // complete macros are more useful
  return s;
}

const dedupeKey = (f) => `${f.brand.toLowerCase()}|${f.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

// ── LLM assist ───────────────────────────────────────────────────────────────
// Two things the scoring rules genuinely cannot do: recognise a misspelling, and make the last
// judgement call between entries that all look reasonable. Both are cached by query, and food
// searches repeat heavily across users — everyone types "chicken breast" — so in practice this is
// one cheap call the first time a given phrase is ever searched, and free afterwards.
const SEARCH_MODEL = process.env.SEARCH_MODEL || 'gpt-4o-mini';
const SPELL_CACHE = new Map();    // query -> corrected query | null
const RERANK_CACHE = new Map();   // query + candidates -> winning index
const LLM_CACHE_MAX = 5000;

function cachePut(map, k, v) {
  if (map.size >= LLM_CACHE_MAX) map.clear();
  map.set(k, v);
  return v;
}

async function askJson(messages, maxTokens) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: SEARCH_MODEL, messages, temperature: 0,
      max_tokens: maxTokens, response_format: { type: 'json_object' },
    }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}`);
  const j = await r.json();
  return JSON.parse(j.choices?.[0]?.message?.content || '{}');
}

/** Levenshtein distance, used only to check a spelling correction stayed close to what was typed. */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** A corrected spelling, or null if it looked fine. "chikn brest" otherwise reaches USDA verbatim
 *  and matches "Paris brest", which no amount of re-ranking can recover from. */
async function spellFix(q) {
  const key = q.toLowerCase();
  if (!OPENAI_API_KEY || q.length < 3) return null;
  if (SPELL_CACHE.has(key)) return SPELL_CACHE.get(key);
  try {
    const out = await askJson([
      { role: 'system', content: 'You fix misspelled food searches. Reply with JSON {"q":"<corrected food name>"} if the input is misspelled, or {"q":null} if the spelling is already correct or you cannot tell what food was meant. Only fix spelling — never substitute a different food, and never add words.' },
      { role: 'user', content: q },
    ], 30);
    const raw = typeof out.q === 'string' ? out.q.trim().slice(0, 60) : '';
    // A correction has to still be the same word. Nothing stops the model "correcting" a brand it
    // does not recognise into a different food entirely, and quietly logging someone a food they
    // never searched for is far worse than showing them no result. Only near-misses are accepted.
    const near = raw && raw.toLowerCase() !== key
      && editDistance(key, raw.toLowerCase()) <= Math.max(2, Math.round(raw.length * 0.34));
    const fixed = near ? raw : null;
    return cachePut(SPELL_CACHE, key, fixed);
  } catch {
    return null;   // an outage must not take out search
  }
}

/** Move the entry a person most likely meant to the front. The rules get the shortlist right; this
 *  settles which of several plausible rows leads, which is a judgement call rather than a pattern.
 *
 *  It only ever reorders rows the rules already scored close to the winner. Given the full page it
 *  answered "big mac" with "Macaroni or noodles with cheese, Easy Mac type" — reading mac as
 *  macaroni and overturning a correct result that the rules had ranked far higher. Settling a close
 *  call is a judgement; overturning a decisive one is a regression. */
const RERANK_BAND = 25;

async function rerank(q, pairs) {
  const foods = pairs.map((p) => p.f);
  if (!OPENAI_API_KEY || pairs.length < 2) return foods;
  const best = pairs[0].s;
  const top = pairs.slice(0, 12).filter((p) => p.s >= best - RERANK_BAND).map((p) => p.f);
  if (top.length < 2) return foods;           // the rules were decisive; nothing to settle
  const key = `${q.toLowerCase()}|${top.map((f) => f.name).join('|')}`;
  let idx = RERANK_CACHE.get(key);
  if (idx === undefined) {
    try {
      const list = top.map((f, i) => `${i}. ${f.brand ? `[${f.brand}] ` : ''}${f.name}`).join('\n');
      const out = await askJson([
        { role: 'system', content: 'Choose which food entry someone most likely meant. Prefer the plain, whole form of the food over dishes, snacks, flavoured or processed variants — unless the search explicitly asks for those. If the search names a brand, restaurant or specific product, keep that product. Reply with JSON {"i":<index>}.' },
        { role: 'user', content: `Search: "${q}"\n${list}` },
      ], 10);
      idx = cachePut(RERANK_CACHE, key, Number.isInteger(out.i) && out.i >= 0 && out.i < top.length ? out.i : 0);
    } catch {
      return foods;
    }
  }
  if (!idx) return foods;
  const pick = top[idx];
  return [pick, ...foods.filter((f) => f !== pick)];
}

/** Everything both sources know about a query, unranked. Split out of the handler so a spelling
 *  correction can simply run it again with the corrected term. */
async function gatherPool(q, country, page) {
  // Two passes over USDA, because one is not enough:
  //
  //  - The broad pass covers everything, including Survey (FNDDS), USDA's "foods as actually eaten"
  //    set of composed dishes like "Burrito, NFS". Without it a search for a real meal returns only
  //    its parts or a frozen version of it.
  //  - But USDA's own relevance ranks that pass, and for a plain ingredient it can bury the
  //    ingredient entirely: "egg", "peanut butter" and "pasta" returned 60 rows with no whole egg,
  //    no jar of peanut butter and no plain pasta among them. Ranking cannot rescue a row that was
  //    never fetched, so a second pass restricted to the curated ingredient sets guarantees the
  //    base food is at least a candidate. Its own ordering is poor — "milk" leads with "Crackers,
  //    milk" — but that does not matter, since scoreFood re-ranks the merged pool.
  const fdcSearch = async (dataType, pageSize) => {
    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${FDC_API_KEY}`
      + `&query=${encodeURIComponent(q)}&pageSize=${pageSize}`
      + `&dataType=${encodeURIComponent(dataType)}`;
    // USDA's edge randomly returns nginx 400s, measured at roughly 1 in 3 on identical URLs. It is
    // not the key, the query or the payload size (limiting nutrients changes nothing), so the only
    // defence is retrying. Without this the whole US catalogue silently vanished from a third of
    // searches and results fell back to Open Food Facts alone.
    let last = 0;
    for (let i = 0; i < 3; i++) {
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        return (Array.isArray(data.foods) ? data.foods : [])
          .map(normalizeFdcFood).filter(Boolean).map((f) => ({ ...f, source: 'fdc' }));
      }
      last = r.status;
      await new Promise((done) => setTimeout(done, 250 * (i + 1)));
    }
    throw new Error(`fdc ${last}`);
  };

  const fdc = (async () => {
    const [broad, curated] = await Promise.allSettled([
      fdcSearch('Foundation,SR Legacy,Survey (FNDDS),Branded', 60),
      fdcSearch('Foundation,SR Legacy', 25),
    ]);
    // The curated pass is a supplement; only a failure of the broad one is a failed search.
    if (broad.status === 'rejected') throw broad.reason;
    return [...broad.value, ...(curated.status === 'fulfilled' ? curated.value : [])];
  })();

  // Hit both in parallel; one source failing (FDC rate limits hard on DEMO_KEY) must not take out
  // the whole search.
  const [a, b] = await Promise.allSettled([fdc, searchOpenFoodFacts(q, country, page)]);
  const all = [...(a.status === 'fulfilled' ? a.value : []),
               ...(b.status === 'fulfilled' ? b.value : [])].filter((f) => f && f.calories > 0);
  return { all, a, b };
}

app.get('/food-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const country = offCountry(req.query.country);   // accepts 'US' or 'united-states'
  // Paging. We over-fetch from both sources, rank the whole pool, then slice, so page 2 is a
  // genuine continuation of one ranking rather than a second, separately-ranked query.
  const page = Math.max(1, Math.min(5, parseInt(req.query.page, 10) || 1));
  const PER_PAGE = 25;
  if (!q) return res.json({ foods: [], page: 1, hasMore: false });

  // The spell check runs alongside the search rather than before it, so a correctly spelled query —
  // almost all of them — waits on nothing. Only a genuine typo pays for the second lookup.
  const [pool, fixed] = await Promise.all([gatherPool(q, country, page), spellFix(q)]);
  let { all, a, b } = pool;
  let used = q;
  if (fixed) {
    const alt = await gatherPool(fixed, country, page);
    // Keep the correction only if it actually found something; otherwise the original stands.
    if (alt.all.length) ({ all, a, b } = alt), (used = fixed);
  }

  if (!all.length) {
    const why = [a, b].filter((x) => x.status === 'rejected').map((x) => String(x.reason)).join('; ');
    if (why) return res.status(502).json({ error: `food search failed (${why})`, foods: [] });
    return res.json({ foods: [] });
  }

  const seen = new Set();
  // Scores are carried alongside the foods rather than discarded, because rerank needs to know how
  // decisive the ranking was before it is allowed to overturn it.
  const ranked = all
    .map((f) => ({ f, s: scoreFood(f, used, country) }))
    .filter((x) => x.s > -1000)                    // drop anything that failed the coverage gate
    .sort((x, y) => y.s - x.s)
    .filter((x) => { const k = dedupeKey(x.f); if (seen.has(k)) return false; seen.add(k); return true; });

  const start = (page - 1) * PER_PAGE;
  const pairs = ranked.slice(start, start + PER_PAGE);
  // Only the first page is re-ranked: it is the only one where which entry leads really matters,
  // and it keeps this to one model call per distinct search rather than one per page.
  let slice = page === 1 ? await rerank(used, pairs) : pairs.map((p) => p.f);

  // Portions are resolved only for the page being returned, not the whole ranked pool — that keeps
  // it to one extra USDA request for at most 25 ids.
  const foods = (await withPortions(slice)).map(perServing);
  res.json({
    foods,
    page,
    hasMore: ranked.length > start + PER_PAGE,
    corrected: used !== q ? used : undefined,   // so the app can show "showing results for ..."
    sources: { fdc: a.status, off: b.status },
  });
});

// ── Coach chat (real LLM, grounded in the user's profile + chosen tone) ───────
// POST /coach  { message, profile, targets, history } → { reply }
const COACH_MODEL = process.env.COACH_MODEL || 'gpt-4o';
const TONE_MAP = {
  supportive: 'Warm and supportive. Encouraging and gentle. Never harsh.',
  direct: 'Direct and no-fluff. Blunt and practical. Straight to the point.',
  hype: 'Hype and motivating. High energy and upbeat, a bit of swagger.',
  toughlove: 'Tough love. Firm, holds them accountable, no coddling.',
  bestie: 'Like a close friend. Casual, warm, a little playful.',
};
function coachSystemPrompt(profile = {}, targets = {}) {
  const p = profile || {}; const t = targets || {};
  const f = [];
  if (p.firstName) f.push(`Name: ${p.firstName}`);
  if (p.age) f.push(`Age: ${p.age}`);
  if (p.gender) f.push(`Sex: ${p.gender}`);
  if (p.heightCm) f.push(`Height: ${p.heightCm} cm`);
  if (p.currentWeightKg) f.push(`Current weight: ${p.currentWeightKg} kg`);
  if (p.goalWeightKg) f.push(`Goal weight: ${p.goalWeightKg} kg`);
  if (p.primaryGoal) f.push(`Main goal: ${p.primaryGoal}`);
  if (p.activityLevel) f.push(`Activity level: ${p.activityLevel}`);
  if (t.dailyCalorieTarget) f.push(`Daily calorie target: ${t.dailyCalorieTarget} kcal`);
  if (t.proteinTargetG) f.push(`Protein target: ${t.proteinTargetG} g`);
  if (Array.isArray(p.diets) && p.diets.length) f.push(`Diet: ${p.diets.join(', ')}`);
  if (Array.isArray(p.allergies) && p.allergies.length) f.push(`Allergies: ${p.allergies.join(', ')}`);
  if (Array.isArray(p.likedFoods) && p.likedFoods.length) f.push(`Foods they like: ${p.likedFoods.join(', ')}`);
  if (Array.isArray(p.dislikedFoods) && p.dislikedFoods.length) f.push(`Foods they dislike: ${p.dislikedFoods.join(', ')}`);
  if (Array.isArray(p.struggles) && p.struggles.length) f.push(`Has struggled with: ${p.struggles.join(', ')}`);
  if (Array.isArray(p.pastAttempts) && p.pastAttempts.length) f.push(`Tried before: ${p.pastAttempts.join(', ')}`);
  const tone = TONE_MAP[p.coachTone] || 'Warm, practical, and direct.';
  return [
    `You are Nudge, this person's personal nutrition and fitness coach inside their app.`,
    `Tone to speak in: ${tone}`,
    ``,
    `What you know about them:`,
    f.length ? f.map((x) => `- ${x}`).join('\n') : '- (limited info so far, ask if you need something)',
    ``,
    `Rules (follow strictly):`,
    `- Answer the exact question they asked. Be specific, concrete, and genuinely useful.`,
    `- Use what you know about them (goal, targets, foods, struggles) when it is relevant. Do not dump their stats unprompted.`,
    `- Use as few words as possible. No preamble, no filler, no restating their question, no sign-off.`,
    `- NEVER use a dash of any kind: no hyphen, no en dash, no em dash. Rewrite with short sentences or commas.`,
    `- Never invent facts about them you were not given.`,
    `- Sound like a real coach, not a chatbot. No "great question", no fake enthusiasm.`,
    `- Plain text only. No markdown, no headers, no bullet symbols unless truly listing items.`,
  ].join('\n');
}
// Retry OpenAI chat on transient errors (429 rate-limit / 5xx server errors) with short backoff.
async function openaiChatWithRetry(body, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (r.ok) return r;
    last = r;
    if (![429, 500, 502, 503, 529].includes(r.status) || i === tries - 1) return r;
    await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
  return last;
}
app.post('/coach', async (req, res) => {
  if (keyMissing(res)) return;
  try {
    const { message, profile, targets, history, image } = req.body || {};
    if (!message) return res.status(400).json({ error: 'no message' });
    const hist = (Array.isArray(history) ? history : []).slice(-8)
      .map((m) => ({ role: m.role === 'coach' ? 'assistant' : 'user', content: String(m.text || '').slice(0, 800) }))
      .filter((m) => m.content);
    const r = await openaiChatWithRetry({
      model: COACH_MODEL,
      temperature: 0.4,
      max_tokens: 220,
      messages: [
        { role: 'system', content: coachSystemPrompt(profile, targets) },
        ...hist,
        // The Coach screen can attach a photo. Without passing it through, the upload is silently
        // dropped and the coach answers as though it never saw the picture.
        {
          role: 'user',
          content: image?.base64
            ? [
                { type: 'text', text: String(message) },
                {
                  type: 'image_url',
                  image_url: { url: `data:${image.mime || 'image/jpeg'};base64,${image.base64}`, detail: 'high' },
                },
              ]
            : String(message),
        },
      ],
    });
    if (!r.ok) return res.status(502).json({ error: `coach failed (${r.status})` });
    const data = await r.json();
    // Safety net: scrub any dashes the model slipped in.
    const reply = String(data?.choices?.[0]?.message?.content || '')
      .replace(/\s+[—–]\s+/g, ', ').replace(/[—–]/g, ', ').replace(/(\S)\s-\s(\S)/g, '$1, $2').trim();
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: 'coach error' });
  }
});

// ── Exercise (free text → structured MET estimate) ───────────────────────────
// The model's ONLY job is to identify the activity, its MET value, and the duration. The kcal maths
// is done here from the person's real body weight, so the number is reproducible and never invented.
// Net burn = (MET - 1) x kg x hours: subtracting 1 MET removes the resting energy they'd have spent
// anyway, which is what "calories burned by exercising" honestly means.
const EXERCISE_SYSTEM = [
  'You convert a description of a workout into structured data. Return JSON only.',
  '',
  'Fields:',
  '- activity: short name of what they did (2 to 4 words, lowercase).',
  '- met: the metabolic equivalent for that activity AT the intensity described, from the Compendium of Physical Activities.',
  '- minutes: total minutes of actual activity. If they gave no duration, infer the most typical duration for that activity and set assumedDuration true.',
  '- assumedDuration: true only if you had to guess the duration.',
  '',
  'MET reference (interpolate sensibly for anything not listed):',
  'walking slow 2mph 2.8 | walking brisk 3.5mph 4.3 | walking uphill/stairs 8.0',
  'jogging 5mph 8.3 | running 6mph 9.8 | running 7.5mph 11.5 | running 10mph 14.5 | sprinting 19.0',
  'cycling leisure 4.0 | cycling moderate 8.0 | cycling vigorous 12.0 | spin class 8.5',
  'swimming leisure 6.0 | swimming laps vigorous 9.8',
  'weight lifting light 3.0 | weight lifting moderate 5.0 | weight lifting vigorous/to failure 6.0',
  'circuit training 7.5 | HIIT 8.0 | crossfit 5.0 | rowing machine moderate 7.0 | elliptical 5.0',
  'yoga 2.5 | pilates 3.0 | stretching 2.3 | dancing 5.0 | hiking 6.0',
  'soccer 7.0 | basketball 6.5 | tennis singles 8.0 | boxing bag work 7.5 | martial arts 10.3',
  'housework 3.0 | gardening 3.8 | playing with kids 4.0',
  '',
  'Rules: pick the MET that matches the intensity words they used (easy/light lowers it, hard/intense/failure raises it).',
  'Never exceed 23. If the text is not exercise at all, set met 0 and minutes 0.',
].join('\n');

app.post('/exercise', async (req, res) => {
  if (keyMissing(res)) return;
  try {
    const { text, profile } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'no text' });
    const kg = Number(profile?.currentWeightKg) > 0 ? Number(profile.currentWeightKg) : 70;

    const r = await openaiChatWithRetry({
      model: COACH_MODEL,
      temperature: 0,
      max_tokens: 160,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXERCISE_SYSTEM },
        { role: 'user', content: String(text).slice(0, 500) },
      ],
    });
    if (!r.ok) return res.status(502).json({ error: `exercise failed (${r.status})` });
    const data = await r.json();

    let parsed = {};
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}'); } catch { parsed = {}; }
    const met = Math.max(0, Math.min(23, Number(parsed.met) || 0));
    const minutes = Math.max(0, Math.min(600, Math.round(Number(parsed.minutes) || 0)));
    // Net of resting energy, and never negative for sub-resting "activities" like stretching.
    const calories = Math.max(0, Math.round(Math.max(0, met - 1) * kg * (minutes / 60)));

    res.json({
      activity: String(parsed.activity || '').slice(0, 60) || 'workout',
      met, minutes, calories,
      assumedDuration: !!parsed.assumedDuration,
      basedOnKg: kg,
    });
  } catch (e) {
    res.status(500).json({ error: 'exercise error' });
  }
});

// ── Menu (photo of a menu → ingredient-reasoned dishes + goal-ranked top 3) ───
const MENU_MODEL = process.env.MENU_MODEL || VISION_MODEL;
const { estimateMenu } = require('./menu-engine');
const fs = require('fs');
const MENU_LOG = require('path').join(__dirname, 'menu-debug.log');
function mlog(...a) { try { fs.appendFileSync(MENU_LOG, `[${new Date().toISOString()}] ${a.map(String).join(' ')}\n`); } catch (e) { /* logging is best-effort */ } }
// The model is a pure EXTRACTOR — it reads dishes + ingredients + infers grams. It does NOT compute
// calories or rank (menu-engine.js does all that deterministically from a grounded portion table).
const MENU_SYSTEM = `You are a menu OCR + ingredient extraction engine. You are given one or more photos of a restaurant menu.

Read EVERY orderable dish (skip section headers, prices, drinks-only items, and add-on/extras lists).
For each dish, list its ingredients EXACTLY as printed on the menu. For each ingredient, infer a realistic restaurant serving in GRAMS — restaurant portions are generous (chunky granola in a bowl ~70g, peanut butter ~30g, shredded coconut ~15g, chia ~15g, maple drizzle ~30g, 1 scoop whey ~30g, ~50g per egg).

Do NOT compute dish calories, totals, macros, or any ranking — ONLY the ingredient rows. The application does all calorie math.

Return VALID JSON ONLY:
{ "items": [ { "name": "", "portion": "", "ingredients": [ { "name": "", "grams": 0 } ] } ] }`;

app.post('/menu', async (req, res) => {
  if (keyMissing(res)) return;
  try {
    const body = req.body || {};
    const g = ['fat_loss', 'muscle_gain', 'maintenance'].includes(body.goal) ? body.goal : 'fat_loss';
    // Accept images[] (multi-page) or a single base64 (back-compat). Cap pages to bound cost.
    let images = Array.isArray(body.images) ? body.images : [];
    if (!images.length && body.base64) images = [{ base64: body.base64, mime: body.mime }];
    images = images.filter((i) => i && i.base64).slice(0, 5);
    if (!images.length) return res.status(400).json({ error: 'no image (base64)' });
    mlog('--- /menu hit — pages:', images.length, 'goal:', g, 'model:', MENU_MODEL);

    const content = [{ type: 'text', text: `Read this menu (${images.length} page image(s)). Extract every dish and its ingredient grams. Return ONLY the JSON.` }];
    for (const im of images) content.push({ type: 'image_url', image_url: { url: `data:${im.mime || 'image/jpeg'};base64,${im.base64}`, detail: 'high' } });

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: MENU_MODEL,
        max_tokens: 8000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: MENU_SYSTEM }, { role: 'user', content }],
      }),
    });
    if (!r.ok) {
      const b = await r.text().catch(() => '');
      mlog('openai NOT ok — status:', r.status, 'body:', b.slice(0, 400));
      return res.status(502).json({ error: `menu failed (${r.status})` });
    }
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content || '{}';
    const finish = data?.choices?.[0]?.finish_reason;
    mlog('openai ok — content len:', text.length, 'finish:', finish);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);          // tolerate trailing prose / minor truncation
      try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
    }
    if (!parsed) {
      mlog('PARSE FAIL — finish:', finish, 'snippet:', text.slice(0, 400));
      return res.status(502).json({ error: 'menu parse error', finish });
    }
    const modelItems = Array.isArray(parsed.items) ? parsed.items : [];
    mlog('extracted', modelItems.length, 'dishes from model. Computing ingredient-summed calories:');
    const result = estimateMenu(modelItems, g, mlog);   // <-- deterministic engine does all the math + ranking
    mlog('computed', result.items.length, 'items; TOP3:', result.top.map((t) => `${t.name} (${t.calorie_low}-${t.calorie_high})`).join(' | '), '\n');
    res.json({ ...result, pagesRead: images.length, dishesFound: modelItems.length });
  } catch (e) {
    mlog('menu handler error:', String((e && e.message) || e));
    res.status(500).json({ error: 'menu error' });
  }
});

// ── Recipe import from a social link ─────────────────────────────────────────
// POST /import-recipe  { url }  →  { title, source, sourceUrl, thumbnailUrl, author,
//                                    rawIngredients[], instructions[], servings }
//
// The app can't fetch these itself: TikTok and Instagram block cross-origin reads and serve a
// login wall to unauthenticated clients, so the fetch has to happen server-side.
//
// Two sources of text, in order of reliability:
//   1. oEmbed  — TikTok and YouTube both publish public, token-free endpoints. TikTok's `title`
//      field is the POST CAPTION, which is exactly where creators write the ingredient list.
//   2. OpenGraph tags off the page HTML — the general fallback (blogs, and sometimes Instagram,
//      whose oEmbed needs a Facebook app token we don't have).
// Whatever text we recover is handed to the model to turn into a structured ingredient list.
const OG_RE = (prop) => new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
const OG_RE_REV = (prop) => new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
const decodeEntities = (s) => String(s || '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

function ogTag(html, prop) {
  const m = html.match(OG_RE(prop)) || html.match(OG_RE_REV(prop));
  return m ? decodeEntities(m[1]) : '';
}

function sourceOf(url) {
  const h = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  if (/tiktok\./.test(h)) return 'tiktok';
  if (/youtube\.|youtu\.be/.test(h)) return 'youtube';
  if (/instagram\./.test(h)) return 'instagram';
  return 'blog';
}

async function fetchWithTimeout(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function oembedFor(source, url) {
  const endpoint = source === 'tiktok' ? `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
    : source === 'youtube' ? `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
    : '';
  if (!endpoint) return null;
  try {
    const r = await fetchWithTimeout(endpoint);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function pageMeta(url) {
  try {
    // A browser UA matters: several of these hosts serve a stub to unknown agents.
    const r = await fetchWithTimeout(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' },
    }, 10000);
    if (!r.ok) return {};
    const html = (await r.text()).slice(0, 400_000);   // meta tags live in <head>; don't hold a whole page
    return {
      title: ogTag(html, 'og:title'),
      image: ogTag(html, 'og:image'),
      description: ogTag(html, 'og:description') || ogTag(html, 'description'),
    };
  } catch { return {}; }
}

const IMPORT_SYSTEM = `You turn a social-media food post into a structured recipe.
You are given the post's caption/description text. Extract ONLY what is actually stated or clearly
implied by it — never invent a recipe you weren't given.
Return JSON: {"title":string,"servings":number|null,"rawIngredients":string[],"instructions":string[],"isRecipe":boolean}
- rawIngredients: one line each, keeping the creator's quantities and wording ("2 chicken breasts, diced").
- instructions: short imperative steps. Empty array if the post doesn't describe a method.
- isRecipe: false if the text is not a food recipe at all.
- title: the dish name, not the caption's hashtags or hype.`;

app.post('/import-recipe', async (req, res) => {
  if (keyMissing(res)) return;
  try {
    // Two ways in. A `url` we fetch ourselves, or `text` the user pasted by hand — the escape hatch
    // for anything behind a login wall (Instagram, private accounts, Stories), which no amount of
    // server-side fetching can read. Both can be supplied: the text carries the recipe, the url
    // still yields a thumbnail.
    const { url, text } = req.body || {};
    const pasted = typeof text === 'string' ? text.trim() : '';
    const hasUrl = !!url && /^https?:\/\//i.test(String(url));
    if (!pasted && !hasUrl) return res.status(400).json({ error: 'a http(s) url or recipe text is required' });

    const source = hasUrl ? sourceOf(url) : 'user';
    const [embed, meta] = hasUrl
      ? await Promise.all([oembedFor(source, url), pageMeta(url)])
      : [null, {}];

    const caption = pasted || [embed?.title, meta.description, meta.title].filter(Boolean).join('\n').trim();
    const thumbnailUrl = embed?.thumbnail_url || meta.image || null;
    const author = embed?.author_name || null;

    if (!caption) {
      // Nothing readable came back — usually a login-walled Instagram post.
      return res.status(422).json({
        error: 'no_text',
        source, sourceUrl: hasUrl ? url : null, thumbnailUrl, author,
        message: "Couldn't read that post. Paste the recipe text instead and we'll take it from there.",
      });
    }

    const r = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 1200,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: IMPORT_SYSTEM },
          { role: 'user', content: `${pasted ? 'Recipe text pasted by the user' : `Post from ${source}`}:\n\n${caption.slice(0, 6000)}` },
        ],
      }),
    }, 30000);
    if (!r.ok) return res.status(502).json({ error: `import failed (${r.status})` });

    const data = await r.json();
    let parsed;
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}'); }
    catch { return res.status(502).json({ error: 'import parse error' }); }

    if (parsed.isRecipe === false || !(parsed.rawIngredients || []).length) {
      return res.status(422).json({
        error: 'not_a_recipe', source, sourceUrl: hasUrl ? url : null, thumbnailUrl, author,
        message: "That post doesn't look like a recipe — no ingredients to read.",
      });
    }

    res.json({
      title: String(parsed.title || embed?.title || 'Imported recipe').slice(0, 120),
      source, sourceUrl: hasUrl ? url : null, thumbnailUrl, author,
      servings: Number.isFinite(parsed.servings) && parsed.servings > 0 ? Math.round(parsed.servings) : null,
      rawIngredients: (parsed.rawIngredients || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 40),
      instructions: (parsed.instructions || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 30),
    });
  } catch (e) {
    res.status(500).json({ error: 'import error' });
  }
});

// ── Moderation (group posts) ─────────────────────────────────────────────────
// POST /moderate  { text }  →  { allowed: boolean, reasons: string[] }
//
// Two passes, because one tool doesn't cover the brief:
//   1. OpenAI's moderation endpoint — free, fast, and the right tool for the serious categories
//      (sexual content, hate, harassment, violence, self-harm). This is what catches nudity.
//   2. A small model call for the two things moderation does NOT classify: ordinary profanity and
//      political content. Both are house rules rather than safety categories.
//
// Fails CLOSED on the safety pass (an unreachable moderation API blocks the post) and OPEN on the
// house-rules pass (a hiccup there shouldn't stop someone posting a recipe).
const HOUSE_RULES = `You screen short posts for a friendly nutrition community.
Answer ONLY with JSON: {"profanity":boolean,"political":boolean}
- profanity: swearing or crude insults. Mild frustration ("this is so hard") is fine.
- political: partisan politics, elections, parties, politicians, divisive social-political campaigning.
  Ordinary talk about food, diets, health, cost of living or supermarkets is NOT political.`;

app.post('/moderate', async (req, res) => {
  if (keyMissing(res)) return;
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });

  const reasons = [];
  try {
    const r = await fetchWithTimeout('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: text.slice(0, 4000) }),
    }, 12000);
    if (!r.ok) throw new Error(`moderation ${r.status}`);
    const cats = (await r.json())?.results?.[0]?.categories || {};
    if (cats.sexual || cats['sexual/minors']) reasons.push('sexual');
    if (cats.hate || cats['hate/threatening'] || cats.harassment || cats['harassment/threatening']) reasons.push('hate');
    if (cats.violence || cats['violence/graphic']) reasons.push('violence');
    if (cats['self-harm'] || cats['self-harm/intent'] || cats['self-harm/instructions']) reasons.push('self-harm');
  } catch {
    // Safety pass unavailable → refuse rather than let unscreened content through.
    return res.json({ allowed: false, reasons: ['unavailable'] });
  }

  try {
    const r = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 40,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: HOUSE_RULES }, { role: 'user', content: text.slice(0, 2000) }],
      }),
    }, 12000);
    if (r.ok) {
      const j = JSON.parse((await r.json())?.choices?.[0]?.message?.content || '{}');
      if (j.profanity) reasons.push('profanity');
      if (j.political) reasons.push('political');
    }
  } catch { /* house rules are best-effort — don't block a recipe over a timeout */ }

  res.json({ allowed: reasons.length === 0, reasons });
});

app.listen(PORT, () => console.log(`Food Swap backend listening on :${PORT}  (key ${OPENAI_API_KEY ? 'set' : 'MISSING'})`));
