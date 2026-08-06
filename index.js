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
    const { base64, mime } = req.body || {};
    if (!base64) return res.status(400).json({ error: 'no image (base64)' });
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
            { type: 'text', text: 'Analyse this meal photo. Identify every visible food item separately, then return ONLY the JSON object.' },
            { type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${base64}`, detail: 'high' } },
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
    serving,
    calories: Math.round(fdcNutrient(food, 1008)),   // Energy (kcal)
    protein: Math.round(fdcNutrient(food, 1003)),    // Protein
    carbs: Math.round(fdcNutrient(food, 1005)),      // Carbohydrate
    fats: Math.round(fdcNutrient(food, 1004)),       // Total lipid (fat)
  };
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
async function searchOpenFoodFacts(q, country) {
  const legacy = 'https://world.openfoodfacts.org/cgi/search.pl'
    + `?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1`
    + `&page_size=30&fields=${OFF_FIELDS}`
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
      + `&page_size=30&fields=${OFF_FIELDS}`;
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

function scoreFood(f, q, country) {
  const query = q.toLowerCase().trim();
  const name = f.name.toLowerCase();
  const brand = (f.brand || '').toLowerCase();
  const hay = `${brand} ${name}`.trim();
  const words = query.split(/\s+/).filter(Boolean);
  let s = 0;

  // Exact wins decisively: without a big gap, "Banana muffin" (prefix match, unbranded) outscores
  // an actual "Banana" once the other bonuses stack up.
  if (name === query) s += 140;
  else if (name.startsWith(query)) s += 60;
  else if (new RegExp(`\\b${escRe(query)}`).test(name)) s += 35;
  else if (name.includes(query)) s += 15;

  // Match across brand AND name, so "tesco hummus" and "greggs sausage roll" find the retailer's
  // own product rather than a generic entry that happens to share one word.
  if (words.every((w) => hay.includes(w))) s += 30;

  // Did the user actually name a brand? Only count a brand hit on a word the NAME doesn't already
  // contain, otherwise "HAPPY HUMMUS" scores as if it were the retailer that was asked for.
  const brandAsked = brand && words.some((w) => w.length > 2 && brand.includes(w) && !name.includes(w));
  if (brandAsked) s += 45;             // "tesco hummus" -> Tesco's own product
  else if (brand) s -= 30;             // no brand asked -> a branded item is probably not what they meant
  else s += 22;                        // generic whole food

  // Source preference follows the market. In the US, USDA's ~450k branded foods ARE the national
  // packaged-goods database and beat OFF's patchier US coverage, so OFF gets no leg up. Everywhere
  // else USDA's branded rows are products you cannot buy, and OFF (country-filtered upstream)
  // carries the real coverage, so it needs a firm push to outrank the flood of US entries.
  if (country && country !== HOME_OF_FDC) {
    if (f.source === 'off') s += 30;
    else if (f.brand) s -= 15;         // US-only branded item shown to a non-US user
  } else if (country === HOME_OF_FDC && f.source === 'fdc') {
    s += 8;
  }

  s -= Math.min(20, name.length / 6);          // prefer concise names over long branded strings
  if (f.protein || f.carbs || f.fats) s += 5;  // complete macros are more useful
  return s;
}

const dedupeKey = (f) => `${f.brand.toLowerCase()}|${f.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

app.get('/food-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const country = offCountry(req.query.country);   // accepts 'US' or 'united-states'
  if (!q) return res.json({ foods: [] });

  const fdc = (async () => {
    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${FDC_API_KEY}`
      + `&query=${encodeURIComponent(q)}&pageSize=25&dataType=${encodeURIComponent('Foundation,SR Legacy,Branded')}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fdc ${r.status}`);
    const data = await r.json();
    return (Array.isArray(data.foods) ? data.foods : [])
      .map(normalizeFdcFood).filter(Boolean).map((f) => ({ ...f, source: 'fdc' }));
  })();

  // Hit both in parallel; one source failing (FDC rate limits hard on DEMO_KEY) must not take out
  // the whole search.
  const [a, b] = await Promise.allSettled([fdc, searchOpenFoodFacts(q, country)]);
  const all = [...(a.status === 'fulfilled' ? a.value : []),
               ...(b.status === 'fulfilled' ? b.value : [])].filter((f) => f && f.calories > 0);

  if (!all.length) {
    const why = [a, b].filter((x) => x.status === 'rejected').map((x) => String(x.reason)).join('; ');
    if (why) return res.status(502).json({ error: `food search failed (${why})`, foods: [] });
    return res.json({ foods: [] });
  }

  const seen = new Set();
  const foods = all
    .sort((x, y) => scoreFood(y, q, country) - scoreFood(x, q, country))
    .filter((f) => { const k = dedupeKey(f); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 25);

  res.json({ foods, sources: { fdc: a.status, off: b.status } });
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
    const { message, profile, targets, history } = req.body || {};
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
        { role: 'user', content: String(message) },
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

app.listen(PORT, () => console.log(`Food Swap backend listening on :${PORT}  (key ${OPENAI_API_KEY ? 'set' : 'MISSING'})`));
