// scripts/scrape-dining.mjs
//
// Pulls Vanderbilt dining hall menus and nutrition out of NetNutrition and
// writes dining/menu.json into the repo.
//
// WHY THIS RUNS ON GITHUB AND NOT IN THE APP
// NetNutrition sends no CORS headers, so a fetch() from bo3beka.github.io is
// blocked by the browser before it ever reaches them. GitHub Actions is not a
// browser, so it has no such restriction. It commits the result back to the
// repo, and the app then reads menu.json from its own origin — same-origin,
// unblocked, and cached offline by the service worker.
//
// WHY IT REPORTS SO MUCH
// NetNutrition is an undocumented internal API whose shape varies between
// deployments and versions, and it cannot be tested from outside. So every
// stage records what it found, and a failure writes dining/debug/ with the raw
// responses. The first run is as much a survey as a scrape.
//
// POLITENESS
// One run a day, one request at a time, a delay between each, an honest
// User-Agent, and a nutrition cache so a repeated item is never looked up
// twice. This should be gentler on their servers than a student clicking
// through the site.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as cheerio from 'cheerio';

const BASE = 'https://netnutrition.cbord.com/nn-prod/vucampusdining';
const ORIGIN = 'https://netnutrition.cbord.com';
const ROOT = '/nn-prod';

const UA = 'fuel-log-menu-bot/1.0 (personal nutrition logging; https://github.com/BO3BEKA/fuel-log)';
const DELAY_MS = 250;        // between requests
const MAX_LABELS = 400;      // hard ceiling per run, so a bug cannot hammer them

const OUT_DIR = 'dining';
const OUT_FILE = `${OUT_DIR}/menu.json`;
const CACHE_FILE = `${OUT_DIR}/nutrition-cache.json`;
const DEBUG_DIR = `${OUT_DIR}/debug`;

// Which halls to keep. Matched case-insensitively as substrings, so "rand"
// catches "Rand Dining Center". Empty means keep everything found.
const WANTED = (process.env.DINING_UNITS || 'rand,commons,kissam,zeppos,ebi,e. bronson')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Session handling
 * ------------------------------------------------------------------ */

// NetNutrition is cookie-driven and Node's fetch does not keep a jar, so this
// tracks Set-Cookie itself.
const jar = new Map();

function storeCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function get(url) {
  await sleep(DELAY_MS);
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Cookie': cookieHeader(),
    },
    redirect: 'follow',
  });
  storeCookies(res);
  return { status: res.status, text: await res.text() };
}

async function post(path, body) {
  await sleep(DELAY_MS);
  const url = `${ORIGIN}${ROOT}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Origin': ORIGIN,
      'Referer': BASE,
      'Cookie': cookieHeader(),
    },
    body: new URLSearchParams(body).toString(),
    redirect: 'follow',
  });
  storeCookies(res);
  return { status: res.status, text: await res.text(), url };
}

/* ------------------------------------------------------------------ *
 * Response shapes
 * ------------------------------------------------------------------ */

// NetNutrition replies with JSON carrying HTML fragments. The exact wrapper
// differs between versions, so every plausible shape is accepted and all HTML
// found anywhere inside is concatenated.
function panelsToHtml(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return text; // some endpoints return bare HTML
  }

  const chunks = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' && /<[a-z][\s\S]*>/i.test(v)) chunks.push(v);
        else walk(v);
      }
    }
  };
  walk(data);
  return chunks.join('\n');
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

// Units, menus and items are all driven by inline onclick handlers carrying
// numeric ids. Rather than depend on class names that change with every
// redesign, this pulls the ids straight out of those handlers.
function extractCalls(html, fnPattern) {
  const $ = cheerio.load(html);
  const out = [];
  $('a, div, li, button, td, tr').each((_, el) => {
    const $el = $(el);
    const attrs = [$el.attr('onclick'), $el.attr('href'), $el.attr('data-action')].filter(Boolean).join(' ');
    if (!attrs) return;
    const m = attrs.match(fnPattern);
    if (!m) return;
    const label = $el.text().replace(/\s+/g, ' ').trim();
    if (label) out.push({ oid: m[1], label });
  });

  // Deduplicate, keeping the longest label for a given id — nested elements
  // often produce both a bare id and a full name.
  const best = new Map();
  for (const o of out) {
    const prev = best.get(o.oid);
    if (!prev || o.label.length > prev.label.length) best.set(o.oid, o);
  }
  return [...best.values()];
}

const UNIT_RE = /selectUnitFromUnitsList\(\s*'?(\d+)'?/i;
const MENU_RE = /(?:selectMenu|menuListSelectMenu)\(\s*'?(\d+)'?/i;
const ITEM_RE = /(?:showLabel|selectLabel|getLabel)\(\s*'?(\d+)'?/i;

// The nutrition label is an HTML table. Values are read by finding the label
// text and taking the number beside it, which survives markup changes far
// better than positional lookups.
function parseLabel(html) {
  const $ = cheerio.load(html);
  const text = $.root().text().replace(/\s+/g, ' ');

  const grab = (patterns, unit) => {
    for (const p of patterns) {
      const re = new RegExp(p + String.raw`\s*:?\s*([\d.]+)\s*` + (unit || ''), 'i');
      const m = text.match(re);
      if (m) return parseFloat(m[1]);
    }
    return 0;
  };

  const name = $('.cbo_nn_LabelHeader, .cbo_nn_labelHeader, h2, h3').first().text().trim()
    || ($('title').text().trim() || '');

  const servingMatch = text.match(/Serving Size\s*:?\s*([^\n]{1,60}?)(?:Amount|Calories|$)/i);

  return {
    name: name.replace(/\s+/g, ' ').trim(),
    serving: servingMatch ? servingMatch[1].trim() : '',
    cal: grab([String.raw`Calories`]),
    fat: grab([String.raw`Total Fat`], 'g'),
    satFat: grab([String.raw`Saturated Fat`], 'g'),
    transFat: grab([String.raw`Trans Fat`], 'g'),
    cholesterol: grab([String.raw`Cholesterol`], 'mg'),
    sodium: grab([String.raw`Sodium`], 'mg'),
    carb: grab([String.raw`Total Carbohydrate`, String.raw`Total Carb`], 'g'),
    fiber: grab([String.raw`Dietary Fiber`, String.raw`Fiber`], 'g'),
    sugars: grab([String.raw`(?:Total )?Sugars`], 'g'),
    addedSugars: grab([String.raw`Added Sugars`], 'g'),
    pro: grab([String.raw`Protein`], 'g'),
    calcium: grab([String.raw`Calcium`], 'mg'),
    iron: grab([String.raw`Iron`], 'mg'),
    potassium: grab([String.raw`Potassium`], 'mg'),
    vitaminD: grab([String.raw`Vitamin D`], 'mcg'),
  };
}

/* ------------------------------------------------------------------ *
 * Debug output
 * ------------------------------------------------------------------ */

const debugFiles = [];
async function dump(name, content) {
  debugFiles.push({ name, content: String(content).slice(0, 200000) });
}
async function flushDebug() {
  if (!debugFiles.length) return;
  await mkdir(DEBUG_DIR, { recursive: true });
  for (const f of debugFiles) {
    await writeFile(`${DEBUG_DIR}/${f.name}`, f.content, 'utf8');
  }
  log(`\nWrote ${debugFiles.length} debug file(s) to ${DEBUG_DIR}/`);
  log('If this run failed, share those and the endpoints can be corrected.');
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  log('Fuel Log — dining menu scrape');
  log('Target:', BASE);
  log('Wanted units:', WANTED.join(', ') || '(all)');
  log('');

  // 1. Establish a session.
  const home = await get(BASE);
  log(`[1] Session page: HTTP ${home.status}, ${home.text.length} bytes, ${jar.size} cookie(s)`);
  await dump('01-home.html', home.text);
  if (home.status !== 200) throw new Error(`Could not load the site (HTTP ${home.status})`);
  if (jar.size === 0) log('    WARNING: no cookies were set. Session-based calls will likely fail.');

  // 2. Find the dining halls.
  let units = extractCalls(home.text, UNIT_RE);
  if (!units.length) {
    log('[2] No units in the landing page; trying the units-list endpoint.');
    const alt = await post('/Unit/GetUnitsList', {});
    await dump('02-units.json', alt.text);
    units = extractCalls(panelsToHtml(alt.text), UNIT_RE);
  }
  log(`[2] Found ${units.length} dining unit(s)`);
  units.forEach((u) => log(`      ${u.oid}  ${u.label}`));
  if (!units.length) throw new Error('No dining halls found — the unit selector has moved.');

  const chosen = WANTED.length
    ? units.filter((u) => WANTED.some((w) => u.label.toLowerCase().includes(w)))
    : units;
  log(`    Keeping ${chosen.length}: ${chosen.map((u) => u.label).join(', ') || '(none matched)'}`);
  if (!chosen.length) throw new Error('None of the wanted units matched. Adjust DINING_UNITS.');

  // 3. Nutrition cache, so a repeated dish is looked up once ever.
  let cache = {};
  if (existsSync(CACHE_FILE)) {
    try { cache = JSON.parse(await readFile(CACHE_FILE, 'utf8')); } catch { cache = {}; }
  }
  log(`[3] Nutrition cache holds ${Object.keys(cache).length} item(s)`);

  const result = { scrapedAt: new Date().toISOString(), source: BASE, units: [] };
  let labelCalls = 0;

  for (const unit of chosen) {
    log(`\n[4] ${unit.label}`);
    const unitRes = await post('/Unit/SelectUnitFromUnitsList', { unitOid: unit.oid });
    const unitHtml = panelsToHtml(unitRes.text);
    await dump(`04-unit-${unit.oid}.html`, unitHtml);

    const menus = extractCalls(unitHtml, MENU_RE);
    log(`    ${menus.length} menu(s)`);
    if (!menus.length) log('    (none found — the menu selector may have moved)');

    const unitOut = { id: unit.oid, name: unit.label, menus: [] };

    // Only the next few days are useful, and it keeps the request count sane.
    for (const menu of menus.slice(0, 4)) {
      const menuRes = await post('/Menu/SelectMenu', { menuOid: menu.oid });
      const menuHtml = panelsToHtml(menuRes.text);
      await dump(`05-menu-${menu.oid}.html`, menuHtml);

      const items = extractCalls(menuHtml, ITEM_RE);
      log(`      "${menu.label}" — ${items.length} item(s)`);

      const menuOut = { id: menu.oid, label: menu.label, items: [] };

      for (const item of items) {
        let nutrition = cache[item.oid];

        if (!nutrition) {
          if (labelCalls >= MAX_LABELS) {
            log(`      hit the ${MAX_LABELS}-label ceiling; the rest resume tomorrow`);
            break;
          }
          const labelRes = await post('/Label/ShowLabel', { detailOid: item.oid });
          labelCalls++;
          const labelHtml = panelsToHtml(labelRes.text);
          if (labelCalls === 1) await dump('06-label-sample.html', labelHtml);
          nutrition = parseLabel(labelHtml);
          if (nutrition.cal > 0 || nutrition.pro > 0) cache[item.oid] = nutrition;
        }

        menuOut.items.push({
          id: item.oid,
          name: nutrition?.name || item.label,
          ...nutrition,
        });
      }

      if (menuOut.items.length) unitOut.menus.push(menuOut);
    }

    if (unitOut.menus.length) result.units.push(unitOut);
  }

  const itemCount = result.units.reduce(
    (a, u) => a + u.menus.reduce((b, m) => b + m.items.length, 0), 0);

  log(`\n[5] ${result.units.length} unit(s), ${itemCount} item(s), ${labelCalls} label lookup(s)`);
  if (itemCount === 0) throw new Error('Nothing was scraped. See the debug files.');

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  log(`    Wrote ${OUT_FILE} and ${CACHE_FILE}`);
}

main()
  .then(flushDebug)
  .catch(async (e) => {
    console.error('\nFAILED:', e.message);
    await flushDebug();
    process.exit(1);
  });
