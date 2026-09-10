// foodsearch.js — turns Open Food Facts and USDA responses into one shape.
//
// Why two sources: USDA's branded database is manufacturer-submitted and goes
// stale when a product is reformulated. Open Food Facts is crowdsourced from
// actual package photos, so it's often fresher on branded goods but patchier on
// generic ingredients. USDA's Foundation and SR Legacy sets are the opposite —
// authoritative for "chicken breast, raw", useless for "Chobani Zero".
//
// So: barcode lookups try Open Food Facts first, text search runs both and
// labels every result with where it came from, and you get the final say.
//
// Everything here normalises to one Candidate shape:
//   { key, name, brand, source, per100, serving, perServing, barcode }
//     per100     — { cal, pro, carb, fat } per 100 g or ml, or null
//     serving     — { label, amount } in the same unit as per100, or null
//     perServing  — { cal, pro, carb, fat } for one serving, or null

import {
  extractFromOFF, extractFromUSDAPer100, extractFromUSDALabel,
  normalizeMicros, hasAnyMicros, NUTRIENT_IDS,
} from './nutrients.js';

const OFF_BASE = 'https://world.openfoodfacts.org';
const USDA_BASE = 'https://api.nal.usda.gov/fdc/v1';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const hasAny = (m) => !!m && (m.cal > 0 || m.pro > 0 || m.carb > 0 || m.fat > 0);

/* ------------------------------------------------------------------ *
 * Open Food Facts
 * ------------------------------------------------------------------ */

// OFF stores a base unit per product: 'g' for solids, 'ml' for drinks.
function offBaseUnit(p) {
  const qty = String(p.quantity || '').toLowerCase();
  const unit = String(p.product_quantity_unit || '').toLowerCase();
  if (unit === 'ml' || unit === 'l' || /\d\s*(ml|l|fl)\b/.test(qty)) return 'ml';
  return 'g';
}

export function normalizeOFFProduct(p, barcode) {
  if (!p) return null;
  const n = p.nutriments || {};
  const name = String(p.product_name || p.generic_name || '').trim();
  if (!name) return null;

  const per100 = {
    cal: num(n['energy-kcal_100g']),
    pro: num(n.proteins_100g),
    carb: num(n.carbohydrates_100g),
    fat: num(n.fat_100g),
  };
  const perServing = {
    cal: num(n['energy-kcal_serving']),
    pro: num(n.proteins_serving),
    carb: num(n.carbohydrates_serving),
    fat: num(n.fat_serving),
  };

  // serving_quantity is in the product's base unit; serving_size is the human
  // string off the label ("170 g", "1 container (150g)").
  const servingAmount = num(p.serving_quantity);
  const servingLabel = String(p.serving_size || '').trim();

  const micros100 = extractFromOFF(n, '_100g');
  const microsServing = extractFromOFF(n, '_serving');

  const cand = {
    key: 'off:' + (barcode || p.code || name),
    name,
    brand: String(p.brands || '').split(',')[0].trim(),
    source: 'Open Food Facts',
    baseUnit: offBaseUnit(p),
    per100: hasAny(per100) ? per100 : null,
    perServing: hasAny(perServing) ? perServing : null,
    micros100: micros100,
    microsServing: microsServing,
    serving: servingAmount > 0 ? { label: servingLabel || '1 serving', amount: servingAmount } : null,
    barcode: barcode || p.code || null,
  };

  if (!cand.per100 && !cand.perServing) return null;
  return cand;
}

export async function offLookupBarcode(barcode) {
  const fields = [
    'code', 'product_name', 'generic_name', 'brands', 'quantity',
    'product_quantity_unit', 'serving_size', 'serving_quantity', 'nutriments',
  ].join(',');
  const url = `${OFF_BASE}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 1 && !data.product) return null;
  return normalizeOFFProduct(data.product, barcode);
}

export async function offSearch(query, limit = 6) {
  const fields = [
    'code', 'product_name', 'generic_name', 'brands', 'quantity',
    'product_quantity_unit', 'serving_size', 'serving_quantity', 'nutriments',
  ].join(',');
  const url = `${OFF_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(query)}` +
    `&search_simple=1&action=process&json=1&page_size=${limit}&fields=${fields}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.products || [])
    .map((p) => normalizeOFFProduct(p, p.code))
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * USDA FoodData Central
 * ------------------------------------------------------------------ */

// USDA returns two nutrients both named "Energy" — one KCAL, one KJ — in no
// guaranteed order. Without the unit filter you silently take a 4.184x
// overcount.
export function pickNutrient(nutrients, matchNames, unit) {
  if (!nutrients) return 0;
  const unitOk = (x) => !unit || String(x.unitName || '').toUpperCase() === unit;
  for (const x of nutrients) {
    if (!unitOk(x)) continue;
    const nm = String(x.nutrientName || '').toLowerCase();
    if (matchNames.some((m) => nm === m)) return num(x.value);
  }
  for (const x of nutrients) {
    if (!unitOk(x)) continue;
    const nm = String(x.nutrientName || '').toLowerCase();
    if (matchNames.some((m) => nm.includes(m))) return num(x.value);
  }
  return 0;
}

function usdaServingUnit(f) {
  const u = String(f.servingSizeUnit || '').toLowerCase();
  if (u === 'ml' || u === 'mlt') return 'ml';
  if (u === 'g' || u === 'grm' || u === 'gram') return 'g';
  return '';
}

export function normalizeUSDAFood(f) {
  if (!f || !f.description) return null;
  const branded = !!f.labelNutrients || f.dataType === 'Branded';
  const nutrients = f.foodNutrients || [];

  // For every USDA data type, foodNutrients is per 100 g.
  const per100 = {
    cal: pickNutrient(nutrients, ['energy'], 'KCAL'),
    pro: pickNutrient(nutrients, ['protein'], 'G'),
    carb: pickNutrient(nutrients, ['carbohydrate, by difference', 'carbohydrate'], 'G'),
    fat: pickNutrient(nutrients, ['total lipid (fat)', 'fat'], 'G'),
  };

  // labelNutrients is the printed panel — per serving, not per 100 g.
  const L = f.labelNutrients || {};
  const perServing = {
    cal: num(L.calories?.value),
    pro: num(L.protein?.value),
    carb: num(L.carbohydrates?.value),
    fat: num(L.fat?.value),
  };

  const micros100 = extractFromUSDAPer100(nutrients);
  const microsServing = extractFromUSDALabel(L);

  const sUnit = usdaServingUnit(f);
  const sAmount = num(f.servingSize);
  const baseUnit = sUnit === 'ml' ? 'ml' : 'g';

  const cand = {
    key: 'usda:' + (f.fdcId || f.description),
    name: String(f.description).trim(),
    brand: String(f.brandName || f.brandOwner || '').trim(),
    source: branded ? 'USDA branded' : 'USDA reference',
    baseUnit,
    per100: hasAny(per100) ? per100 : null,
    perServing: hasAny(perServing) ? perServing : null,
    micros100: micros100,
    microsServing: microsServing,
    serving: sAmount > 0 && sUnit ? { label: `1 serving (${sAmount}${sUnit})`, amount: sAmount } : null,
    barcode: f.gtinUpc || null,
    stale: branded, // manufacturer-submitted; worth a nudge to double-check
  };

  if (!cand.per100 && !cand.perServing) return null;
  return cand;
}

export async function usdaSearch(query, apiKey, limit = 8) {
  if (!apiKey) return [];
  // Restricting the data types keeps out the Experimental and Survey sets,
  // which are the main source of nonsense matches.
  const url = `${USDA_BASE}/foods/search?api_key=${encodeURIComponent(apiKey)}` +
    `&query=${encodeURIComponent(query)}&pageSize=${limit}` +
    `&dataType=${encodeURIComponent('Branded,Foundation,SR Legacy')}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error('USDA search failed with status ' + res.status);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data.foods || []).map(normalizeUSDAFood).filter(Boolean);
}

export async function usdaLookupBarcode(barcode, apiKey) {
  if (!apiKey) return null;
  const hits = await usdaSearch(barcode, apiKey, 5);
  // Only trust it if the UPC actually matches — a bare number query will
  // happily return unrelated foods.
  const digits = String(barcode).replace(/^0+/, '');
  return hits.find((h) => h.barcode && String(h.barcode).replace(/^0+/, '') === digits) || null;
}

/* ------------------------------------------------------------------ *
 * Combined search
 * ------------------------------------------------------------------ */

// Branded queries want Open Food Facts first; single-ingredient queries want
// USDA's reference sets. Rather than guess, run both and interleave, so the
// right answer is near the top either way.
export async function searchFoods(query, { usdaKey } = {}) {
  const [offRes, usdaRes] = await Promise.allSettled([
    offSearch(query, 6),
    usdaSearch(query, usdaKey, 8),
  ]);

  const off = offRes.status === 'fulfilled' ? offRes.value : [];
  const usda = usdaRes.status === 'fulfilled' ? usdaRes.value : [];

  const errors = [];
  if (offRes.status === 'rejected') errors.push('Open Food Facts unreachable');
  if (usdaRes.status === 'rejected') {
    errors.push(usdaRes.reason?.status === 403 ? 'USDA key rejected' : 'USDA unreachable');
  }
  if (!usdaKey) errors.push('No USDA key set');

  // USDA reference entries first (authoritative for real ingredients), then
  // Open Food Facts branded, then USDA branded last since it's the stalest.
  const refs = usda.filter((c) => c.source === 'USDA reference');
  const usdaBranded = usda.filter((c) => c.source === 'USDA branded');

  const seen = new Set();
  const out = [];
  for (const c of [...refs, ...off, ...usdaBranded]) {
    const sig = (c.brand + '|' + c.name).toLowerCase();
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(c);
  }

  return { results: out.slice(0, 14), errors };
}

// A scanned UPC-A (12 digits) and the EAN-13 stored in a database differ by a
// leading zero, and entries exist both ways. Try the sensible variants.
export function barcodeVariants(code) {
  const c = String(code).replace(/\D/g, '');
  const out = new Set([c]);
  if (c.length === 12) out.add('0' + c);
  if (c.length === 13 && c.startsWith('0')) out.add(c.slice(1));
  if (c.length === 8) out.add(c.padStart(13, '0'));
  return [...out];
}

// Barcode: Open Food Facts is the barcode-native database, USDA is the backup.
export async function lookupBarcode(barcode, { usdaKey } = {}) {
  for (const variant of barcodeVariants(barcode)) {
    try {
      const hit = await offLookupBarcode(variant);
      if (hit) return hit;
    } catch (e) {
      console.warn('OFF barcode lookup failed for', variant, e);
    }
  }
  try {
    return await usdaLookupBarcode(barcode, usdaKey);
  } catch (e) {
    console.warn('USDA barcode lookup failed', e);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Candidate -> food (the shape portions.js and store.js use)
 * ------------------------------------------------------------------ */

export function candidateToFood(c) {
  const displayName = c.brand && !c.name.toLowerCase().includes(c.brand.toLowerCase())
    ? `${c.brand} ${c.name}`
    : c.name;

  const per100Micros = normalizeMicros(c.micros100);
  const servingMicros = normalizeMicros(c.microsServing);
  const servingAmount = c.serving && c.serving.amount > 0 ? c.serving.amount : 0;

  // Micros have to end up on the same basis as the macros, or a 150 g yogurt
  // logs its sodium as though it were 100 g.
  const microsPer100 = hasAnyMicros(per100Micros)
    ? per100Micros
    : (hasAnyMicros(servingMicros) && servingAmount > 0
        ? scaleObj(servingMicros, 100 / servingAmount)
        : {});

  // Best case: a per-100 rate, so grams and ounces both work, with the label
  // serving kept as a named one-tap portion.
  if (c.per100) {
    const servings = c.serving ? [{ label: c.serving.label, amount: c.serving.amount }] : [];
    return {
      name: displayName,
      cal: c.per100.cal, pro: c.per100.pro, carb: c.per100.carb, fat: c.per100.fat,
      micros: microsPer100,
      refAmount: 100,
      refUnit: c.baseUnit === 'ml' ? 'ml' : 'g',
      servings,
      defaultQty: servings.length ? 1 : 100,
      defaultUnitId: servings.length ? 's0' : (c.baseUnit === 'ml' ? 'ml' : 'g'),
      barcode: c.barcode || null,
    };
  }

  // Only a label panel and a gram weight: convert back to a per-100 rate so it
  // still scales by weight.
  if (c.perServing && servingAmount > 0) {
    const f = 100 / servingAmount;
    return {
      name: displayName,
      cal: c.perServing.cal * f, pro: c.perServing.pro * f,
      carb: c.perServing.carb * f, fat: c.perServing.fat * f,
      micros: microsPer100,
      refAmount: 100,
      refUnit: c.baseUnit === 'ml' ? 'ml' : 'g',
      servings: [{ label: c.serving.label, amount: c.serving.amount }],
      defaultQty: 1,
      defaultUnitId: 's0',
      barcode: c.barcode || null,
    };
  }

  // A label panel with no weight at all. Servings are all we can honestly
  // offer, so the micros stay on a per-serving basis too.
  return {
    name: displayName,
    cal: c.perServing.cal, pro: c.perServing.pro, carb: c.perServing.carb, fat: c.perServing.fat,
    micros: hasAnyMicros(servingMicros) ? servingMicros : per100Micros,
    refAmount: 1,
    refUnit: 'serving',
    servings: [],
    defaultQty: 1,
    defaultUnitId: 'serving',
    barcode: c.barcode || null,
  };
}

function scaleObj(obj, factor) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    const v = Number(obj[k]);
    if (Number.isFinite(v) && v > 0) out[k] = v * factor;
  }
  return out;
}

// What a result row shows so you can spot a wrong match before logging it.
export function candidateSummary(c) {
  if (c.per100) {
    return {
      macros: c.per100,
      basis: `per 100${c.baseUnit}`,
    };
  }
  return {
    macros: c.perServing,
    basis: c.serving ? `per ${c.serving.label}` : 'per serving',
  };
}

// Shape for the shared Firestore barcode cache. Must match the key list in
// firestore.rules exactly or the write is rejected.
export function candidateToCache(c) {
  // Micros are nested inside the existing per100g / perServing maps on purpose.
  // firestore.rules restricts TOP-LEVEL keys only, so nesting means the cache
  // can carry new nutrients without republishing rules.
  const per100 = c.per100 ? { ...c.per100, ...normalizeMicros(c.micros100) } : null;
  const perServ = c.perServing ? { ...c.perServing, ...normalizeMicros(c.microsServing) } : null;
  return {
    name: c.name,
    brand: c.brand || '',
    per100g: per100,
    perServing: perServ,
    servingSize: c.serving ? c.serving.amount : 0,
    servingUnit: c.serving ? c.serving.label : '',
    source: c.source,
    updatedAt: Date.now(),
  };
}

function splitMacros(map) {
  if (!map) return { macros: null, micros: {} };
  const macros = {
    cal: num(map.cal), pro: num(map.pro), carb: num(map.carb), fat: num(map.fat),
  };
  const micros = {};
  for (const id of NUTRIENT_IDS) {
    const v = Number(map[id]);
    if (Number.isFinite(v) && v > 0) micros[id] = v;
  }
  return { macros: hasAny(macros) ? macros : null, micros };
}

export function cacheToCandidate(d, barcode) {
  if (!d) return null;
  const a = splitMacros(d.per100g);
  const b = splitMacros(d.perServing);
  return {
    key: 'cache:' + barcode,
    name: d.name,
    brand: d.brand || '',
    source: d.source || 'cached',
    baseUnit: 'g',
    per100: a.macros,
    perServing: b.macros,
    micros100: a.micros,
    microsServing: b.micros,
    serving: d.servingSize > 0 ? { label: d.servingUnit || '1 serving', amount: d.servingSize } : null,
    barcode,
  };
}
