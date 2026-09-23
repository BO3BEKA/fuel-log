// insights.js — the analysis that makes a food log worth keeping.
//
// The headline is back-calculated TDEE. A calculator's estimate of your
// maintenance calories is a population average applied to you; it can be off by
// several hundred either way. But if you log intake and weigh yourself, your
// own body tells you the answer:
//
//   maintenance ≈ mean daily intake − (weight change in lbs × 3500 ÷ days)
//
// Gaining half a pound a week on 3,000 calories means maintenance is about
// 2,750. No formula needed, and it's yours rather than a stranger's.
//
// Everything here is pure. No storage, no DOM, no dates beyond YYYY-MM-DD keys.

export const KCAL_PER_LB = 3500;

// Minimum evidence before a TDEE estimate is worth showing. Below this the
// number swings wildly with water weight and it does more harm than good.
export const MIN_INTAKE_DAYS = 10;
export const MIN_WEIGH_INS = 4;
export const MIN_SPAN_DAYS = 10;

/* ------------------------------------------------------------------ *
 * Date helpers (keys are 'YYYY-MM-DD')
 * ------------------------------------------------------------------ */

export function keyToDate(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function dateToKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function daysBetween(aKey, bKey) {
  return Math.round((keyToDate(bKey) - keyToDate(aKey)) / 86400000);
}
export function lastNDayKeys(endKey, n) {
  const end = keyToDate(endKey);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    out.push(dateToKey(d));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Statistics
 * ------------------------------------------------------------------ */

// Least-squares fit. Points are { x, y } with x in days.
export function linearTrend(points) {
  const pts = (points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pts.length;
  if (n < 2) return null;

  const sx = pts.reduce((a, p) => a + p.x, 0);
  const sy = pts.reduce((a, p) => a + p.y, 0);
  const mx = sx / n;
  const my = sy / n;

  let num = 0, den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  if (den === 0) return null; // every reading on the same day

  const slope = num / den;
  const intercept = my - slope * mx;

  let ssRes = 0, ssTot = 0;
  for (const p of pts) {
    ssRes += (p.y - (slope * p.x + intercept)) ** 2;
    ssTot += (p.y - my) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return { slope, intercept, r2, n };
}

// Trailing average, so each point reflects that day and the ones before it.
// Daily weight swings 2-3 lbs on water alone; this is what makes a trend
// readable at all.
export function movingAverage(series, window = 7) {
  const sorted = (series || []).slice().sort((a, b) => (a.key < b.key ? -1 : 1));
  return sorted.map((point, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = sorted.slice(start, i + 1);
    const avg = slice.reduce((a, p) => a + p.value, 0) / slice.length;
    return { key: point.key, value: point.value, avg, n: slice.length };
  });
}

export function mean(nums) {
  const list = (nums || []).filter((n) => Number.isFinite(n));
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
}

/* ------------------------------------------------------------------ *
 * Intake
 * ------------------------------------------------------------------ */

// Days with no entries are skipped rather than counted as zero — an unlogged
// day is missing data, not a fast, and averaging zeros in would wreck both the
// average and the TDEE estimate.
export function averageIntake(intakeByDay, dayKeys) {
  const vals = (dayKeys || [])
    .map((k) => Number(intakeByDay?.[k]))
    .filter((v) => Number.isFinite(v) && v > 0);
  return { average: mean(vals), days: vals.length, logged: vals.length };
}

/* ------------------------------------------------------------------ *
 * TDEE
 * ------------------------------------------------------------------ */

// intakeByDay: { 'YYYY-MM-DD': calories }
// weightsByDay: { 'YYYY-MM-DD': lbs }
export function estimateTDEE(intakeByDay, weightsByDay, opts = {}) {
  const minIntake = opts.minIntakeDays ?? MIN_INTAKE_DAYS;
  const minWeighIns = opts.minWeighIns ?? MIN_WEIGH_INS;
  const minSpan = opts.minSpanDays ?? MIN_SPAN_DAYS;

  const weightKeys = Object.keys(weightsByDay || {})
    .filter((k) => Number(weightsByDay[k]) > 0)
    .sort();
  const intakeKeys = Object.keys(intakeByDay || {})
    .filter((k) => Number(intakeByDay[k]) > 0)
    .sort();

  if (weightKeys.length < minWeighIns) {
    return { ok: false, reason: 'weigh-ins', have: weightKeys.length, need: minWeighIns };
  }

  const first = weightKeys[0];
  const last = weightKeys[weightKeys.length - 1];
  const span = daysBetween(first, last);
  if (span < minSpan) {
    return { ok: false, reason: 'span', have: span, need: minSpan };
  }

  // Only intake inside the weighed window can explain the weight change.
  const inWindow = intakeKeys.filter((k) => daysBetween(first, k) >= 0 && daysBetween(k, last) >= 0);
  if (inWindow.length < minIntake) {
    return { ok: false, reason: 'intake', have: inWindow.length, need: minIntake };
  }

  // Regression rather than first-minus-last: a single bloated weigh-in at
  // either end would otherwise move the answer by hundreds of calories.
  const trend = linearTrend(weightKeys.map((k) => ({ x: daysBetween(first, k), y: Number(weightsByDay[k]) })));
  if (!trend) return { ok: false, reason: 'span', have: span, need: minSpan };

  const meanIntake = mean(inWindow.map((k) => Number(intakeByDay[k])));
  const lbsPerDay = trend.slope;
  const tdee = meanIntake - lbsPerDay * KCAL_PER_LB;

  // Coverage is what actually determines whether to trust this. Logging 11 of
  // 30 days gives a mean intake that is not your real mean intake.
  const coverage = inWindow.length / (span + 1);
  const confidence =
    coverage >= 0.8 && weightKeys.length >= 8 && span >= 14 ? 'good'
    : coverage >= 0.6 && span >= 10 ? 'fair'
    : 'rough';

  return {
    ok: true,
    tdee: Math.round(tdee),
    meanIntake: Math.round(meanIntake),
    lbsPerWeek: lbsPerDay * 7,
    days: span + 1,
    loggedDays: inWindow.length,
    weighIns: weightKeys.length,
    coverage,
    confidence,
    r2: trend.r2,
    firstKey: first,
    lastKey: last,
  };
}

// Plain-language read of the trend, in the units people actually think in.
export function describeTrend(lbsPerWeek) {
  const v = Number(lbsPerWeek) || 0;
  const abs = Math.abs(v);
  if (abs < 0.15) return 'holding steady';
  const dir = v > 0 ? 'gaining' : 'losing';
  return `${dir} about ${abs.toFixed(1)} lb a week`;
}

/* ------------------------------------------------------------------ *
 * Macro split
 * ------------------------------------------------------------------ */

// Atwater factors: the calories each gram of a macro actually provides.
export const KCAL_PER_G = { pro: 4, carb: 4, fat: 9 };

// The split is by CALORIES, not grams, because grams are not comparable — fat
// carries 9 calories a gram against 4 for the other two, so 50g of fat is a
// much larger share of a day than 50g of protein. Percentages by weight would
// make fat look small when it is the biggest contributor.
export function macroSplit(totals) {
  const g = {
    pro: Math.max(0, Number(totals?.pro) || 0),
    carb: Math.max(0, Number(totals?.carb) || 0),
    fat: Math.max(0, Number(totals?.fat) || 0),
  };

  const cal = {
    pro: g.pro * KCAL_PER_G.pro,
    carb: g.carb * KCAL_PER_G.carb,
    fat: g.fat * KCAL_PER_G.fat,
  };

  const derived = cal.pro + cal.carb + cal.fat;
  const logged = Math.max(0, Number(totals?.cal) || 0);

  const pct = (v) => (derived > 0 ? (v / derived) * 100 : 0);

  // Macro calories rarely match logged calories exactly — rounding, alcohol,
  // fibre and sugar alcohols all drive a wedge between them. A small gap is
  // normal; a large one usually means an entry is missing its macros.
  const gap = logged > 0 && derived > 0 ? Math.abs(logged - derived) / logged : 0;

  return {
    empty: derived <= 0,
    grams: g,
    calories: cal,
    derivedCal: derived,
    loggedCal: logged,
    parts: [
      { id: 'carb', label: 'Carbs',   grams: g.carb, cal: cal.carb, pct: pct(cal.carb) },
      { id: 'fat',  label: 'Fat',     grams: g.fat,  cal: cal.fat,  pct: pct(cal.fat) },
      { id: 'pro',  label: 'Protein', grams: g.pro,  cal: cal.pro,  pct: pct(cal.pro) },
    ],
    // Flagged only when the gap is big enough to be a real discrepancy rather
    // than rounding.
    mismatch: gap > 0.15,
    gapCal: Math.round(logged - derived),
  };
}

// Turns percentages into SVG stroke-dasharray segments for a donut.
export function donutSegments(parts, circumference) {
  let offset = 0;
  return parts.map((p) => {
    const len = (p.pct / 100) * circumference;
    const seg = { id: p.id, label: p.label, pct: p.pct, length: len, offset: -offset };
    offset += len;
    return seg;
  });
}

/* ------------------------------------------------------------------ *
 * Protein distribution across meals
 * ------------------------------------------------------------------ */

// Protein is used better spread across the day than dumped into one meal, so
// showing the split is more useful than the daily total alone.
export function proteinSplit(groups) {
  const rows = (groups || []).map((g) => ({
    id: g.id,
    label: g.label,
    protein: (g.entries || []).reduce((a, e) => a + (Number(e.pro) || 0), 0),
  }));
  const total = rows.reduce((a, r) => a + r.protein, 0);
  const withPct = rows.map((r) => ({ ...r, pct: total > 0 ? (r.protein / total) * 100 : 0 }));
  const nonEmpty = withPct.filter((r) => r.protein > 0);
  const biggest = nonEmpty.reduce((a, r) => (r.protein > (a?.protein ?? -1) ? r : a), null);

  return {
    rows: withPct,
    total,
    // Flag a lopsided day, but only once there is enough protein for the
    // observation to mean anything.
    lopsided: !!biggest && total >= 60 && biggest.pct > 55,
    biggest,
  };
}
