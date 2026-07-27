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
app.get('/food-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ foods: [] });
  try {
    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${FDC_API_KEY}`
      + `&query=${encodeURIComponent(q)}&pageSize=25&dataType=${encodeURIComponent('Foundation,SR Legacy,Branded')}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: `food search failed (${r.status})` });
    const data = await r.json();
    const foods = (Array.isArray(data.foods) ? data.foods : [])
      .map(normalizeFdcFood)
      .filter((f) => f && f.calories > 0)
      .slice(0, 20);
    res.json({ foods });
  } catch (e) {
    res.status(500).json({ error: 'food search error' });
  }
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
