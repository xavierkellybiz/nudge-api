// Menu estimation engine — the model only EXTRACTS dishes + ingredient grams; this file does ALL
// calorie/macro math (grounded in a portion table), applies floors, and ranks deterministically.
// Pure functions, no deps — unit-testable with hand-built model output (see menu-engine.test.js).

// Per 100g: kcal + protein/carb/fat, plus a realistic restaurant DEFAULT portion (grams).
// Ordered list — more specific patterns first (coconut milk before coconut). `null` = flavour/process
// word that carries ~no calories (cinnamon, salt, "organic", "house made"…).
const TABLE = [
  [/coconut milk/, { kcal: 200, p: 2, c: 3, f: 21, g: 100 }],
  [/coconut flour/, { kcal: 400, p: 18, c: 60, f: 14, g: 25 }],
  [/coconut (yog|yoghurt|yogurt)/, { kcal: 180, p: 2, c: 8, f: 16, g: 100 }],
  [/desiccated coconut|shredded coconut|coconut/, { kcal: 660, p: 7, c: 24, f: 64, g: 15 }],
  [/peanut butter|nut butter|\bpb\b|pb2/, { kcal: 590, p: 25, c: 20, f: 50, g: 30 }],
  [/almond butter/, { kcal: 614, p: 21, c: 19, f: 56, g: 30 }],
  [/granola|muesli/, { kcal: 450, p: 10, c: 64, f: 16, g: 70 }],
  [/chia/, { kcal: 490, p: 17, c: 42, f: 31, g: 15 }],
  [/pumpkin seed|sunflower seed|hemp seed|\bseeds?\b/, { kcal: 560, p: 30, c: 11, f: 49, g: 15 }],
  [/flax|linseed/, { kcal: 530, p: 18, c: 29, f: 42, g: 12 }],
  [/maple/, { kcal: 260, p: 0, c: 67, f: 0, g: 30 }],
  [/honey/, { kcal: 304, p: 0, c: 82, f: 0, g: 21 }],
  [/syrup/, { kcal: 280, p: 0, c: 70, f: 0, g: 30 }],
  [/olive oil|coconut oil|\boils?\b/, { kcal: 884, p: 0, c: 0, f: 100, g: 10 }],
  [/dressing|mayo|aioli/, { kcal: 450, p: 1, c: 10, f: 45, g: 30 }],
  [/tahini/, { kcal: 595, p: 17, c: 21, f: 54, g: 20 }],
  [/walnut|almond|cashew|pecan|hazelnut|pistachio|macadamia|crushed nuts|mixed nuts|\bnuts?\b/, { kcal: 600, p: 20, c: 20, f: 50, g: 20 }],
  [/halloumi|feta|mozzarella|parmesan|cheese/, { kcal: 380, p: 24, c: 2, f: 31, g: 30 }],
  [/avocado/, { kcal: 160, p: 2, c: 9, f: 15, g: 100 }],
  [/biscoff|crumble|cookie|crumb/, { kcal: 480, p: 6, c: 65, f: 22, g: 25 }],
  [/cacao|cocoa|dark choc|chocolate/, { kcal: 560, p: 8, c: 46, f: 40, g: 15 }],
  [/sauce|compote|drizzle/, { kcal: 250, p: 0, c: 60, f: 0, g: 20 }],
  [/whey|casein|protein powder|protein scoop|\bscoop\b|whey protein|\bprotein\b/, { kcal: 380, p: 78, c: 8, f: 6, g: 30 }],
  [/rolled oats|organic oats|\boats?\b/, { kcal: 380, p: 13, c: 67, f: 7, g: 60 }],
  [/quinoa/, { kcal: 350, p: 14, c: 64, f: 6, g: 60 }],
  [/\brice\b/, { kcal: 130, p: 2.7, c: 28, f: 0.3, g: 180 }],
  [/egg white/, { kcal: 52, p: 11, c: 1, f: 0, g: 90 }],
  [/\beggs?\b/, { kcal: 155, p: 13, c: 1, f: 11, g: 100 }],   // bowls usually ~2 eggs → ~100g
  [/greek (yog|yoghurt|yogurt)/, { kcal: 90, p: 9, c: 5, f: 4, g: 120 }],
  [/yog|yoghurt|yogurt/, { kcal: 95, p: 6, c: 8, f: 4, g: 120 }],
  [/banana/, { kcal: 90, p: 1, c: 23, f: 0.3, g: 120 }],
  [/strawber|raspber|blueber|blackber|mixed berr|berries|berry/, { kcal: 50, p: 1, c: 12, f: 0.3, g: 60 }],
  [/acai/, { kcal: 100, p: 1, c: 16, f: 5, g: 100 }],
  [/mango/, { kcal: 60, p: 0.8, c: 15, f: 0.4, g: 80 }],
  [/apple/, { kcal: 60, p: 0.3, c: 15, f: 0.2, g: 120 }],
  [/spirulina/, { kcal: 290, p: 57, c: 24, f: 8, g: 5 }],
  [/collagen/, { kcal: 360, p: 90, c: 0, f: 0, g: 12 }],
  [/ice ?cream/, { kcal: 200, p: 8, c: 20, f: 8, g: 80 }],
  [/\bmilk\b/, { kcal: 62, p: 3.2, c: 5, f: 3.3, g: 120 }],
  [/sourdough|bread|bagel|bun|muffin|wrap|tortilla|toast|loaf/, { kcal: 270, p: 9, c: 49, f: 4, g: 60 }],
  [/bacon/, { kcal: 540, p: 37, c: 1, f: 42, g: 30 }],
  [/chicken/, { kcal: 165, p: 31, c: 0, f: 3.6, g: 150 }],
  [/beef|mince|patty|steak/, { kcal: 250, p: 26, c: 0, f: 17, g: 120 }],
  [/salmon|tuna|prawn/, { kcal: 200, p: 22, c: 0, f: 12, g: 130 }],
  [/fruit/, { kcal: 55, p: 0.7, c: 14, f: 0.2, g: 120 }],
  // flavour / process descriptors with negligible calories
  [/cinnamon|vanilla|sea salt|\bsalt\b|stevia|sweetener|spice|herb|cacao nib|water|ice\b/, null],
];
const GENERIC = { kcal: 120, p: 3, c: 18, f: 4, g: 60 };  // unmatched edible ingredient fallback

function lookup(name) {
  const n = String(name || '').toLowerCase();
  for (const [re, data] of TABLE) if (re.test(n)) return data === null ? { skip: true } : { matched: true, data };
  return { matched: false };
}

// Dish-pattern calorie floors (a granola+PB bowl can't realistically be 250).
function floorFor(nameAndPortion, ings) {
  const n = nameAndPortion.toLowerCase();
  const has = (re) => ings.some((x) => re.test(x.name.toLowerCase()));
  const granola = has(/granola|muesli/), pb = has(/peanut butter|nut butter|\bpb\b/);
  const coconut = has(/coconut/), seeds = has(/chia|seed/), syrup = has(/syrup|maple|honey/);
  const isBowl = /\bbowl\b/.test(n) || (granola && has(/banana/));
  const isAcaiSmoothie = /acai|smoothie/.test(n) || has(/acai/);
  const isPancake3 = /pancake/.test(n) && /(3 ?pc|stack|3 ?piece|triple)/.test(n);
  const isWaffle = /waffle/.test(n);
  let floor = 0;
  if (isBowl && granola && pb) floor = Math.max(floor, 500);
  if (isAcaiSmoothie && granola && coconut && seeds) floor = Math.max(floor, 600);
  if (isPancake3) floor = Math.max(floor, 650);
  if (isWaffle && syrup) floor = Math.max(floor, 600);
  return floor;
}

const r10 = (n) => Math.round(n / 10) * 10;

function computeItem(it, log) {
  const name = String((it && it.name) || '').trim();
  if (!name) return null;
  const portion = String((it && it.portion) || '').trim();
  const rawIngs = Array.isArray(it && it.ingredients) ? it.ingredients : [];
  const ings = [];
  let kcal = 0, p = 0, c = 0, f = 0;
  for (const ing of rawIngs) {
    const iname = String((ing && ing.name) || '').trim();
    if (!iname) continue;
    const res = lookup(iname);
    if (res.skip) { ings.push({ name: iname, grams: 0, kcal_100g: 0, kcal: 0, confidence: 'high' }); continue; }
    const mg = Number(ing && ing.grams);
    let grams, kcal100, pp, cc, ff, conf;
    if (res.matched) {
      const t = res.data;
      grams = Math.max((Number.isFinite(mg) && mg > 0 && mg < 600) ? mg : t.g, t.g); // floor at realistic portion
      kcal100 = t.kcal; pp = t.p; cc = t.c; ff = t.f; conf = 'high';
    } else {
      const mk = Number(ing && ing.kcal_100g);
      grams = (Number.isFinite(mg) && mg > 0 && mg < 600) ? mg : 60;
      kcal100 = (Number.isFinite(mk) && mk > 30 && mk < 900) ? mk : GENERIC.kcal;
      pp = GENERIC.p; cc = GENERIC.c; ff = GENERIC.f; conf = 'low';        // unknown ingredient → low conf
    }
    const ik = Math.round((grams * kcal100) / 100);
    kcal += ik; p += (grams * pp) / 100; c += (grams * cc) / 100; f += (grams * ff) / 100;
    ings.push({ name: iname, grams: Math.round(grams), kcal_100g: kcal100, kcal: ik, confidence: conf });
  }

  const floor = floorFor(`${name} ${portion}`, ings);
  let lo = r10(kcal * 0.82);
  let hi = r10(kcal * 1.12);
  let floored = false;
  if (floor && lo < floor) { lo = floor; hi = Math.max(hi, r10(floor * 1.12)); floored = true; }

  const counted = ings.filter((x) => x.kcal > 0);
  const lowConf = counted.filter((x) => x.confidence === 'low').length;
  const confidence = counted.length >= 4 && lowConf === 0 ? 'high' : counted.length >= 2 ? 'medium' : 'low';
  const reasoning = [...counted].sort((a, b) => b.kcal - a.kcal).slice(0, 3).map((x) => `${x.name} ~${x.kcal}`).join(', ')
    + (floored ? ` · floored to ${floor}` : '');

  if (log) log(`  • "${name}" → ${kcal} kcal → range ${lo}-${hi}${floored ? ` (FLOOR ${floor})` : ''} | ${ings.map((x) => `${x.name}:${x.grams}g=${x.kcal}`).join('; ')}`);

  return {
    name, calorie_low: lo, calorie_high: hi,
    protein_g: Math.round(p), carbs_g: Math.round(c), fat_g: Math.round(f),
    confidence, reasoning, ingredients: ings,
  };
}

function scoreFor(it, goal) {
  const cal = (it.calorie_low + it.calorie_high) / 2;
  const prot = it.protein_g;
  const ppc = prot / Math.max(cal, 1);
  const sugary = it.ingredients.some((x) => /syrup|maple|honey|biscoff|sauce|choc|compote/.test(x.name.toLowerCase()));
  const liquid = it.ingredients.some((x) => /coconut milk|\bmilk\b|smoothie/.test(x.name.toLowerCase()));
  if (goal === 'muscle_gain') return prot * 2 + Math.min(cal, 900) * 0.08;
  if (goal === 'maintenance') return prot - Math.abs(cal - 550) * 0.03 - (sugary ? 4 : 0);
  return ppc * 1000 - cal * 0.03 - (sugary ? 6 : 0) - (liquid ? 5 : 0);   // fat_loss
}

function whyFor(it, goal) {
  const cal = Math.round((it.calorie_low + it.calorie_high) / 2);
  if (goal === 'muscle_gain') return `${it.protein_g}g protein at ~${cal} cal — strong for muscle gain.`;
  if (goal === 'maintenance') return `Balanced ~${cal} cal with ${it.protein_g}g protein.`;
  return `${it.protein_g}g protein for ~${cal} cal — best protein-per-calorie here.`;
}

/** modelItems → { goal, items[] (computed), top[] (ranked) }. `log` is optional (string sink). */
function estimateMenu(modelItems, goal, log) {
  const g = ['fat_loss', 'muscle_gain', 'maintenance'].includes(goal) ? goal : 'fat_loss';
  const items = (Array.isArray(modelItems) ? modelItems : [])
    .map((it) => computeItem(it, log))
    .filter((x) => x && x.name && x.calorie_high > 0);
  items.forEach((it) => { it.score = Math.round(scoreFor(it, g) * 10) / 10; });
  const top = [...items].sort((a, b) => b.score - a.score).slice(0, 3)
    .map((it) => ({ name: it.name, calorie_low: it.calorie_low, calorie_high: it.calorie_high, protein_g: it.protein_g, why: whyFor(it, g) }));
  return { goal: g, items, top };
}

module.exports = { estimateMenu, computeItem, lookup, TABLE };
