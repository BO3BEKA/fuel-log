// portions.js — all the portion and unit math, with no storage or DOM in it.
//
// The core idea: a food no longer stores "650 calories". It stores nutrition
// for a reference amount — "per 100 g" or "per 1 serving" — and logging
// multiplies by how much you actually ate.
//
//   food = { name, refAmount: 100, refUnit: 'g', cal: 165, pro: 31, ... }
//   you log 250 g  ->  factor = 250 / 100 = 2.5  ->  412 cal, 78 g protein
//
// refUnit is always one of 'g', 'ml' or 'serving'. Named portions ("1 breast",
// "1 scoop") are stored as an amount in the food's own refUnit, so the scaling
// maths never has to know what a breast is.

export const MASS_UNITS = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
export const VOLUME_UNITS = { ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588, floz: 29.5735 };

export const UNIT_LABELS = {
  g: 'g', kg: 'kg', oz: 'oz', lb: 'lb',
  ml: 'ml', l: 'L', tsp: 'tsp', tbsp: 'tbsp', cup: 'cup', floz: 'fl oz',
  serving: 'serving',
};

export const MEALS = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch' },
  { id: 'dinner', label: 'Dinner' },
  { id: 'snack', label: 'Snacks' },
];

// Which meal a given moment most likely belongs to. Only ever a default — the
// log sheet always lets you override it.
export function inferMeal(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h < 10.5) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

export function mealLabel(id) {
  return (MEALS.find((m) => m.id === id) || { label: 'Snacks' }).label;
}

/* ------------------------------------------------------------------ *
 * Normalising
 * ------------------------------------------------------------------ */

// Foods saved by version 1 of the app have no refAmount — they were a flat
// "one of these = 650 cal". Treating them as one serving keeps every old quick
// add working exactly as it did, and they can be given real gram amounts later
// by editing them.
export function normalizeFood(raw) {
  if (!raw) return null;
  const f = { ...raw };

  if (!f.refUnit || !Number.isFinite(Number(f.refAmount)) || Number(f.refAmount) <= 0) {
    f.refUnit = 'serving';
    f.refAmount = 1;
  }
  f.refAmount = Number(f.refAmount);

  f.cal = Number(f.cal) || 0;
  f.pro = Number(f.pro) || 0;
  f.carb = Number(f.carb) || 0;
  f.fat = Number(f.fat) || 0;

  f.servings = Array.isArray(f.servings)
    ? f.servings
        .map((s) => ({ label: String(s.label || '').trim(), amount: Number(s.amount) || 0 }))
        .filter((s) => s.label && s.amount > 0)
    : [];

  // What one tap on the quick-add grid logs.
  if (!Number.isFinite(Number(f.defaultQty)) || Number(f.defaultQty) <= 0) {
    f.defaultQty = f.refAmount;
    f.defaultUnitId = f.refUnit;
  }
  f.defaultQty = Number(f.defaultQty);
  if (!f.defaultUnitId) f.defaultUnitId = f.refUnit;

  f.logCount = Number(f.logCount) || 0;
  return f;
}

/* ------------------------------------------------------------------ *
 * Portion options
 * ------------------------------------------------------------------ */

// Everything you could pick from the quantity dropdown for this food. Each
// option knows how much of the food's own reference unit it represents, which
// is all `scale` needs.
export function portionOptions(food) {
  const f = normalizeFood(food);
  const out = [];

  if (f.refUnit === 'g') {
    for (const [u, grams] of Object.entries(MASS_UNITS)) {
      out.push({ id: u, label: UNIT_LABELS[u], amount: grams });
    }
  } else if (f.refUnit === 'ml') {
    for (const [u, ml] of Object.entries(VOLUME_UNITS)) {
      out.push({ id: u, label: UNIT_LABELS[u], amount: ml });
    }
  } else {
    out.push({ id: 'serving', label: 'serving', amount: 1 });
  }

  f.servings.forEach((s, i) => {
    const suffix = f.refUnit === 'serving' ? '' : ` (${trimNum(s.amount)}${f.refUnit})`;
    out.push({ id: 's' + i, label: s.label + suffix, amount: s.amount, named: true });
  });

  return out;
}

export function findOption(food, optionId) {
  const opts = portionOptions(food);
  return opts.find((o) => o.id === optionId) || opts[0];
}

/* ------------------------------------------------------------------ *
 * Scaling
 * ------------------------------------------------------------------ */

// The one function that matters. Returns the macros for `qty` of `optionId`.
export function scale(food, qty, optionId) {
  const f = normalizeFood(food);
  const opt = findOption(f, optionId);
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return { cal: 0, pro: 0, carb: 0, fat: 0 };

  const factor = (q * opt.amount) / f.refAmount;
  return {
    cal: f.cal * factor,
    pro: f.pro * factor,
    carb: f.carb * factor,
    fat: f.fat * factor,
  };
}

// How the portion reads on the log row: "250 g", "2 × 1 breast", "1 serving".
export function describePortion(qty, food, optionId) {
  const opt = findOption(food, optionId);
  const q = trimNum(qty);
  if (opt.named) return q === '1' ? opt.label.replace(/\s*\(.*\)$/, '') : `${q} × ${opt.label.replace(/\s*\(.*\)$/, '')}`;
  if (opt.id === 'serving') return `${q} serving${Number(qty) === 1 ? '' : 's'}`;
  return `${q} ${opt.label}`;
}

/* ------------------------------------------------------------------ *
 * Building a food from a USDA search result
 * ------------------------------------------------------------------ */

// Generic USDA entries are per 100 g. Branded ones carry a label panel with a
// serving size, which is far more useful, so it becomes a named portion.
export function foodFromUSDA(result) {
  const base = { name: result.name, cal: result.cal, pro: result.pro, carb: result.carb, fat: result.fat };

  if (result.perLabelServing) {
    const grams = Number(result.servingGrams) || 0;
    if (grams > 0) {
      // Convert the label panel back to a per-100g rate so grams and ounces
      // also work, then keep the label serving as a named option.
      const f = 100 / grams;
      return normalizeFood({
        ...base,
        cal: base.cal * f, pro: base.pro * f, carb: base.carb * f, fat: base.fat * f,
        refAmount: 100, refUnit: 'g',
        servings: [{ label: result.servingLabel || '1 serving', amount: grams }],
        defaultQty: 1, defaultUnitId: 's0',
      });
    }
    // A label with no gram weight: servings are all we can offer.
    return normalizeFood({
      ...base, refAmount: 1, refUnit: 'serving',
      defaultQty: 1, defaultUnitId: 'serving',
    });
  }

  return normalizeFood({
    ...base, refAmount: 100, refUnit: 'g',
    defaultQty: 100, defaultUnitId: 'g',
  });
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

export function trimNum(v) {
  const num = Number(v) || 0;
  if (Number.isInteger(num)) return String(num);
  return String(Math.round(num * 100) / 100);
}

export const round = (v) => Math.round(Number(v) || 0);

export function sumMacros(entries) {
  return entries.reduce(
    (a, e) => ({
      cal: a.cal + (Number(e.cal) || 0),
      pro: a.pro + (Number(e.pro) || 0),
      carb: a.carb + (Number(e.carb) || 0),
      fat: a.fat + (Number(e.fat) || 0),
    }),
    { cal: 0, pro: 0, carb: 0, fat: 0 }
  );
}

export function groupByMeal(entries) {
  const groups = MEALS.map((m) => ({ ...m, entries: [] }));
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  for (const e of entries) {
    const id = e.meal && byId[e.meal] ? e.meal : inferMeal(new Date(Number(e.at) || Date.now()));
    byId[id].entries.push(e);
  }
  return groups;
}
