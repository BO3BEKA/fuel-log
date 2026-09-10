// nutrients.js — the single table of everything tracked beyond the four macros,
// plus the extraction logic for each data source.
//
// Adding a nutrient means adding one row here. The manual entry form, the edit
// form, the detail panel, the scaling maths and both database importers all
// read from this table, so nothing else needs touching.
//
// Each row carries:
//   id        key used in storage
//   label     full name for forms and the detail panel
//   unit      'g' | 'mg' | 'mcg' — the unit values are STORED in
//   dv        FDA Daily Value for adults, for the % DV column. null = no DV.
//   group     heading in the form and detail panel
//   off       Open Food Facts nutriment key (before the _100g suffix)
//   usda      USDA nutrientName matches, lowercase, first hit wins
//   usdaUnit  the unit USDA reports it in
//   labelKey  USDA labelNutrients key (per serving)
//   labelUnit the unit that label field is in
//   max100    largest believable amount per 100 g, used to disambiguate
//             Open Food Facts values (see extractFromOFF)

export const NUTRIENTS = [
  // --- Fats ---
  { id: 'satFat', label: 'Saturated fat', unit: 'g', dv: 20, group: 'Fats',
    off: 'saturated-fat', usda: ['fatty acids, total saturated'], usdaUnit: 'G',
    labelKey: 'saturatedFat', labelUnit: 'g', max100: 100 },
  { id: 'transFat', label: 'Trans fat', unit: 'g', dv: null, group: 'Fats',
    off: 'trans-fat', usda: ['fatty acids, total trans'], usdaUnit: 'G',
    labelKey: 'transFat', labelUnit: 'g', max100: 100 },
  { id: 'cholesterol', label: 'Cholesterol', unit: 'mg', dv: 300, group: 'Fats',
    off: 'cholesterol', usda: ['cholesterol'], usdaUnit: 'MG',
    labelKey: 'cholesterol', labelUnit: 'mg', max100: 3000 },

  // --- Carbohydrate detail ---
  { id: 'fiber', label: 'Fiber', unit: 'g', dv: 28, group: 'Carbs',
    off: 'fiber', usda: ['fiber, total dietary'], usdaUnit: 'G',
    labelKey: 'fiber', labelUnit: 'g', max100: 100 },
  { id: 'sugars', label: 'Total sugars', unit: 'g', dv: null, group: 'Carbs',
    off: 'sugars', usda: ['sugars, total including nlea', 'total sugars', 'sugars, total'], usdaUnit: 'G',
    labelKey: 'sugars', labelUnit: 'g', max100: 100 },
  { id: 'addedSugars', label: 'Added sugars', unit: 'g', dv: 50, group: 'Carbs',
    off: 'added-sugars', usda: ['sugars, added'], usdaUnit: 'G',
    labelKey: 'addedSugars', labelUnit: 'g', max100: 100 },

  // --- Minerals ---
  { id: 'sodium', label: 'Sodium', unit: 'mg', dv: 2300, group: 'Minerals',
    off: 'sodium', usda: ['sodium, na'], usdaUnit: 'MG',
    labelKey: 'sodium', labelUnit: 'mg', max100: 40000 },
  { id: 'potassium', label: 'Potassium', unit: 'mg', dv: 4700, group: 'Minerals',
    off: 'potassium', usda: ['potassium, k'], usdaUnit: 'MG',
    labelKey: 'potassium', labelUnit: 'mg', max100: 20000 },
  { id: 'calcium', label: 'Calcium', unit: 'mg', dv: 1300, group: 'Minerals',
    off: 'calcium', usda: ['calcium, ca'], usdaUnit: 'MG',
    labelKey: 'calcium', labelUnit: 'mg', max100: 40000 },
  { id: 'iron', label: 'Iron', unit: 'mg', dv: 18, group: 'Minerals',
    off: 'iron', usda: ['iron, fe'], usdaUnit: 'MG',
    labelKey: 'iron', labelUnit: 'mg', max100: 1000 },
  { id: 'magnesium', label: 'Magnesium', unit: 'mg', dv: 420, group: 'Minerals',
    off: 'magnesium', usda: ['magnesium, mg'], usdaUnit: 'MG',
    labelKey: null, labelUnit: null, max100: 5000 },
  { id: 'zinc', label: 'Zinc', unit: 'mg', dv: 11, group: 'Minerals',
    off: 'zinc', usda: ['zinc, zn'], usdaUnit: 'MG',
    labelKey: null, labelUnit: null, max100: 1000 },

  // --- Vitamins ---
  { id: 'vitaminA', label: 'Vitamin A', unit: 'mcg', dv: 900, group: 'Vitamins',
    off: 'vitamin-a', usda: ['vitamin a, rae'], usdaUnit: 'UG',
    labelKey: null, labelUnit: null, max100: 200000 },
  { id: 'vitaminC', label: 'Vitamin C', unit: 'mg', dv: 90, group: 'Vitamins',
    off: 'vitamin-c', usda: ['vitamin c, total ascorbic acid'], usdaUnit: 'MG',
    labelKey: null, labelUnit: null, max100: 5000 },
  { id: 'vitaminD', label: 'Vitamin D', unit: 'mcg', dv: 20, group: 'Vitamins',
    off: 'vitamin-d', usda: ['vitamin d (d2 + d3)', 'vitamin d'], usdaUnit: 'UG',
    labelKey: 'vitaminD', labelUnit: 'mcg', max100: 2000 },
  { id: 'vitaminB12', label: 'Vitamin B12', unit: 'mcg', dv: 2.4, group: 'Vitamins',
    off: 'vitamin-b12', usda: ['vitamin b-12'], usdaUnit: 'UG',
    labelKey: null, labelUnit: null, max100: 1000 },
];

export const NUTRIENT_IDS = NUTRIENTS.map((n) => n.id);
export const NUTRIENT_BY_ID = Object.fromEntries(NUTRIENTS.map((n) => [n.id, n]));

export const NUTRIENT_GROUPS = NUTRIENTS.reduce((acc, n) => {
  (acc[n.group] = acc[n.group] || []).push(n);
  return acc;
}, {});

/* ------------------------------------------------------------------ *
 * Units
 * ------------------------------------------------------------------ */

const TO_GRAMS = { g: 1, mg: 1e-3, mcg: 1e-6, ug: 1e-6, µg: 1e-6 };

function unitKey(u) {
  const s = String(u || '').trim().toLowerCase();
  if (s === 'ug' || s === 'µg' || s === 'mcg') return 'mcg';
  if (s === 'mg') return 'mg';
  if (s === 'g' || s === 'grm' || s === 'gram') return 'g';
  return s;
}

// Converts between g, mg and mcg. Returns null for units it can't handle,
// notably IU, which has no fixed mass equivalence — it depends on the compound.
export function convert(value, from, to) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const f = TO_GRAMS[unitKey(from)];
  const t = TO_GRAMS[unitKey(to)];
  if (!f || !t) return null;
  return (v * f) / t;
}

/* ------------------------------------------------------------------ *
 * Normalising a stored micros object
 * ------------------------------------------------------------------ */

// Keeps only known ids with finite non-negative numbers, and drops zeros so
// stored documents stay small.
export function normalizeMicros(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of NUTRIENT_IDS) {
    const v = Number(raw[id]);
    if (Number.isFinite(v) && v > 0) out[id] = v;
  }
  return out;
}

export function scaleMicros(micros, factor) {
  const out = {};
  if (!micros) return out;
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0) return out;
  for (const id of NUTRIENT_IDS) {
    const v = Number(micros[id]);
    if (Number.isFinite(v) && v > 0) out[id] = v * f;
  }
  return out;
}

export function sumMicros(list) {
  const out = {};
  for (const item of list || []) {
    const m = item && item.micros;
    if (!m) continue;
    for (const id of NUTRIENT_IDS) {
      const v = Number(m[id]);
      if (Number.isFinite(v) && v > 0) out[id] = (out[id] || 0) + v;
    }
  }
  return out;
}

export function hasAnyMicros(micros) {
  return !!micros && NUTRIENT_IDS.some((id) => Number(micros[id]) > 0);
}

/* ------------------------------------------------------------------ *
 * Open Food Facts
 * ------------------------------------------------------------------ */

// OFF's `_100g` fields are documented as being in grams, but plenty of entries
// come through already in the label's own unit. Rather than trust either, take
// the grams reading and fall back to the raw number when grams gives an amount
// that could not physically fit in 100 g of food.
export function extractFromOFF(nutriments, suffix = '_100g') {
  const out = {};
  if (!nutriments) return out;

  for (const n of NUTRIENTS) {
    if (!n.off) continue;
    const raw = Number(nutriments[n.off + suffix]);
    if (!Number.isFinite(raw) || raw <= 0) continue;

    const asGrams = convert(raw, 'g', n.unit);
    if (asGrams != null && asGrams <= n.max100) {
      out[n.id] = asGrams;
      continue;
    }
    // Grams gave something impossible, so the value was already in n.unit.
    if (raw <= n.max100) out[n.id] = raw;
  }

  // OFF often carries salt but not sodium. Salt is ~39.3% sodium by mass.
  if (!out.sodium) {
    const salt = Number(nutriments['salt' + suffix]);
    if (Number.isFinite(salt) && salt > 0) {
      const mg = convert(salt * 0.3933, 'g', 'mg');
      if (mg != null && mg <= NUTRIENT_BY_ID.sodium.max100) out.sodium = mg;
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * USDA
 * ------------------------------------------------------------------ */

// foodNutrients is per 100 g for every USDA data type.
export function extractFromUSDAPer100(foodNutrients) {
  const out = {};
  if (!Array.isArray(foodNutrients)) return out;

  const rows = foodNutrients.map((x) => ({
    name: String(x.nutrientName || '').trim().toLowerCase(),
    unit: String(x.unitName || '').trim(),
    value: Number(x.value),
  }));

  for (const n of NUTRIENTS) {
    let hit = rows.find((r) => n.usda.includes(r.name) && Number.isFinite(r.value) && r.value > 0);
    if (!hit) {
      hit = rows.find((r) => n.usda.some((m) => r.name.startsWith(m)) && Number.isFinite(r.value) && r.value > 0);
    }
    if (!hit) continue;
    const v = convert(hit.value, hit.unit || n.usdaUnit, n.unit);
    if (v != null && v > 0) out[n.id] = v;
  }
  return out;
}

// labelNutrients is the printed panel, so per serving rather than per 100 g.
export function extractFromUSDALabel(labelNutrients) {
  const out = {};
  if (!labelNutrients) return out;
  for (const n of NUTRIENTS) {
    if (!n.labelKey) continue;
    const v = Number(labelNutrients[n.labelKey]?.value);
    if (!Number.isFinite(v) || v <= 0) continue;
    const conv = convert(v, n.labelUnit || n.unit, n.unit);
    if (conv != null && conv > 0) out[n.id] = conv;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Display
 * ------------------------------------------------------------------ */

export function formatAmount(id, value) {
  const n = NUTRIENT_BY_ID[id];
  const v = Number(value) || 0;
  if (!n) return String(Math.round(v));
  // Small amounts need a decimal to mean anything; large ones don't.
  const digits = v < 1 ? 2 : v < 10 ? 1 : 0;
  return v.toFixed(digits).replace(/\.0+$/, '') + n.unit;
}

export function pctDV(id, value) {
  const n = NUTRIENT_BY_ID[id];
  if (!n || !n.dv) return null;
  return Math.round(((Number(value) || 0) / n.dv) * 100);
}
