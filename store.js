// store.js — the only file in the app that knows where data lives.
//
// Two interchangeable backends behind one interface:
//   LocalStore  — localStorage. No account, this device only.
//   CloudStore  — Firestore + anonymous auth, with offline persistence.
//
// The app picks CloudStore when firebase-config.js has real values, otherwise
// LocalStore, so it never hard-fails while you are mid-setup.
//
// Interface (both backends):
//   await init()                     -> { mode, uid }
//   onStatus(cb)                     -> cb({ mode, label, tone })
//   onGoals(cb) / onRecent(cb) / onFoods(cb)
//   watchDay(dayKey, cb)             -> unsubscribe(); cb([entry])
//   getDayEntries(dayKey)            -> [entry]   (one-off read)
//   setGoals(goals)
//   addEntry(dayKey, entry) / addEntries(dayKey, []) / removeEntry(dayKey, id)
//   copyDay(fromKey, toKey)          -> number copied
//   addFood(food) / updateFood(id, patch) / deleteFood(id) / bumpFood(id)
//   noteRecent(food)
//   signInWithGoogle() / currentUser()

import { firebaseConfig, isConfigured, SDK } from "./firebase-config.js";
import { normalizeFood } from "./portions.js";

const PREFIX = "fuellog:";
const PRESETS_KEY = PREFIX + "presets";
const GOALS_KEY = PREFIX + "goals";
const RECENT_KEY = PREFIX + "recent";
const dayStorageKey = (k) => PREFIX + "log:" + k;

const RECENT_MAX = 20;

export const DEFAULT_GOALS = { calories: 2700, protein: 155, carbs: 0, fat: 0 };

// Seeded on a brand new install. One-serving foods, which is the honest shape
// for a dining hall estimate — give any of them real gram amounts later by
// editing them.
export const DEFAULT_FOODS = [
  { id: "p1", name: "Rand Dining — chicken bowl", cal: 650, pro: 45, carb: 60, fat: 18, refAmount: 1, refUnit: "serving" },
  { id: "p2", name: "Rand Dining — omelet + toast", cal: 520, pro: 30, carb: 40, fat: 22, refAmount: 1, refUnit: "serving" },
  { id: "p3", name: "Publix — rotisserie chicken + rice", cal: 600, pro: 50, carb: 55, fat: 15, refAmount: 1, refUnit: "serving" },
  { id: "p4", name: "Publix — protein shake", cal: 250, pro: 30, carb: 12, fat: 6, refAmount: 1, refUnit: "serving" },
  { id: "p5", name: "Commons — pasta station", cal: 700, pro: 25, carb: 95, fat: 20, refAmount: 1, refUnit: "serving" },
  { id: "p6", name: "Protein bar", cal: 220, pro: 20, carb: 22, fat: 7, refAmount: 1, refUnit: "serving" },
];

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("localStorage write failed", key, e);
  }
}
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Everything written for a logged item. Macros are computed at log time and
// stored, so editing a food later never rewrites your history.
function entryPayload(e) {
  return {
    name: String(e.name || "").slice(0, 200),
    cal: Number(e.cal) || 0,
    pro: Number(e.pro) || 0,
    carb: Number(e.carb) || 0,
    fat: Number(e.fat) || 0,
    qty: Number(e.qty) || 1,
    portionId: e.portionId || "serving",
    portionLabel: String(e.portionLabel || "").slice(0, 60),
    meal: e.meal || "snack",
    foodId: e.foodId || null,
    time: e.time || "",
    at: Number(e.at) || Date.now(),
  };
}

function foodPayload(f) {
  const n = normalizeFood(f);
  return {
    name: String(n.name || "").slice(0, 200),
    cal: n.cal, pro: n.pro, carb: n.carb, fat: n.fat,
    refAmount: n.refAmount,
    refUnit: n.refUnit,
    servings: n.servings.slice(0, 8),
    defaultQty: n.defaultQty,
    defaultUnitId: n.defaultUnitId,
    logCount: Number(f.logCount) || 0,
    lastUsed: Number(f.lastUsed) || Date.now(),
  };
}

// A compact copy of a food you just logged, for the Recent strip.
function recentPayload(f) {
  const n = normalizeFood(f);
  return {
    name: n.name,
    cal: n.cal, pro: n.pro, carb: n.carb, fat: n.fat,
    refAmount: n.refAmount, refUnit: n.refUnit,
    servings: n.servings.slice(0, 4),
    defaultQty: n.defaultQty, defaultUnitId: n.defaultUnitId,
    at: Date.now(),
  };
}

function mergeRecent(list, food) {
  const item = recentPayload(food);
  if (!item.name) return list || [];
  const rest = (list || []).filter((r) => r && r.name !== item.name);
  return [item, ...rest].slice(0, RECENT_MAX);
}

/* ------------------------------------------------------------------ *
 * LocalStore
 * ------------------------------------------------------------------ */

class LocalStore {
  constructor() {
    this.mode = "local";
    this.fellBack = false;
    this._cbs = { status: null, goals: null, foods: null, recent: null };
    this._day = { key: null, cb: null };
  }

  async init() {
    return { mode: "local", uid: null };
  }

  onStatus(cb) {
    this._cbs.status = cb;
    cb({
      mode: "local",
      label: this.fellBack ? "Cloud unreachable — local only" : "This device only",
      tone: this.fellBack ? "warn" : "muted",
    });
  }

  onGoals(cb) {
    this._cbs.goals = cb;
    cb({ ...DEFAULT_GOALS, ...loadJSON(GOALS_KEY, {}) });
  }

  onFoods(cb) {
    this._cbs.foods = cb;
    cb(this._foods());
  }

  onRecent(cb) {
    this._cbs.recent = cb;
    cb(loadJSON(RECENT_KEY, []));
  }

  _foods() {
    return loadJSON(PRESETS_KEY, DEFAULT_FOODS).map(normalizeFood).filter(Boolean);
  }
  _emitFoods() {
    if (this._cbs.foods) this._cbs.foods(this._foods());
  }
  _emitDay(dayKey) {
    if (this._day.cb && this._day.key === dayKey) {
      this._day.cb(loadJSON(dayStorageKey(dayKey), []));
    }
  }

  watchDay(dayKey, cb) {
    this._day = { key: dayKey, cb };
    cb(loadJSON(dayStorageKey(dayKey), []));
    return () => {
      if (this._day.key === dayKey) this._day = { key: null, cb: null };
    };
  }

  async getDayEntries(dayKey) {
    return loadJSON(dayStorageKey(dayKey), []);
  }

  async setGoals(goals) {
    saveJSON(GOALS_KEY, goals);
    if (this._cbs.goals) this._cbs.goals(goals);
  }

  async addEntry(dayKey, entry) {
    return this.addEntries(dayKey, [entry]);
  }

  async addEntries(dayKey, entries) {
    if (entries.length === 0) return 0;
    const list = loadJSON(dayStorageKey(dayKey), []);
    for (const e of entries) list.push({ id: newId("e"), ...entryPayload(e) });
    saveJSON(dayStorageKey(dayKey), list);
    this._emitDay(dayKey);
    return entries.length;
  }

  async removeEntry(dayKey, entryId) {
    saveJSON(dayStorageKey(dayKey), loadJSON(dayStorageKey(dayKey), []).filter((e) => e.id !== entryId));
    this._emitDay(dayKey);
  }

  async copyDay(fromKey, toKey) {
    const src = await this.getDayEntries(fromKey);
    if (src.length === 0) return 0;
    const now = Date.now();
    const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return this.addEntries(toKey, src.map((e) => ({ ...e, at: now, time })));
  }

  async addFood(food) {
    const foods = loadJSON(PRESETS_KEY, DEFAULT_FOODS);
    const id = food.id || newId("p");
    foods.push({ id, ...foodPayload({ ...food, logCount: 1 }) });
    saveJSON(PRESETS_KEY, foods);
    this._emitFoods();
    return id;
  }

  async updateFood(id, patch) {
    saveJSON(
      PRESETS_KEY,
      loadJSON(PRESETS_KEY, DEFAULT_FOODS).map((f) =>
        f.id === id ? { id, ...foodPayload({ ...normalizeFood(f), ...patch }) } : f
      )
    );
    this._emitFoods();
  }

  async deleteFood(id) {
    saveJSON(PRESETS_KEY, loadJSON(PRESETS_KEY, DEFAULT_FOODS).filter((f) => f.id !== id));
    this._emitFoods();
  }

  async bumpFood(id) {
    saveJSON(
      PRESETS_KEY,
      loadJSON(PRESETS_KEY, DEFAULT_FOODS).map((f) =>
        f.id === id ? { ...f, logCount: (Number(f.logCount) || 0) + 1, lastUsed: Date.now() } : f
      )
    );
    this._emitFoods();
  }

  async noteRecent(food) {
    const next = mergeRecent(loadJSON(RECENT_KEY, []), food);
    saveJSON(RECENT_KEY, next);
    if (this._cbs.recent) this._cbs.recent(next);
  }

  async getCachedBarcode(upc) {
    return loadJSON(PREFIX + "barcode:" + upc, null);
  }

  async cacheBarcode(upc, data) {
    saveJSON(PREFIX + "barcode:" + upc, data);
  }

  async signInWithGoogle() {
    throw new Error("Add your Firebase config first.");
  }

  redirectPending() { return false; }
  redirectError() { return null; }
  currentUser() {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * CloudStore
 * ------------------------------------------------------------------ */

class CloudStore {
  constructor(fb) {
    this.mode = "cloud";
    this.fellBack = false;
    this.fb = fb;
    this.uid = null;
    this._statusCb = null;
    this._statusState = { mode: "cloud", label: "Connecting", tone: "muted" };
    this._userSubs = [];
    this._userData = {};
    this._userLoaded = false;
  }

  _setStatus(label, tone) {
    this._statusState = { mode: "cloud", label, tone };
    if (this._statusCb) this._statusCb(this._statusState);
  }

  onStatus(cb) {
    this._statusCb = cb;
    cb(this._statusState);
  }

  async init() {
    const { auth, onAuthStateChanged, signInAnonymously } = this.fb;

    // Must happen before anonymous sign-in, or a pending redirect gets
    // stranded and you land back on a fresh throwaway account.
    await this._completeRedirect();

    const user = await new Promise((resolve, reject) => {
      const stop = onAuthStateChanged(
        auth,
        (u) => {
          if (u) {
            stop();
            resolve(u);
          } else {
            signInAnonymously(auth).catch(reject);
          }
        },
        reject
      );
    });

    this.uid = user.uid;
    this._userRef = this.fb.doc(this.fb.db, "users", this.uid);

    window.addEventListener("online", () => this._setStatus("Synced", "ok"));
    window.addEventListener("offline", () => this._setStatus("Offline — saving locally", "warn"));
    this._setStatus(
      navigator.onLine ? "Synced" : "Offline — saving locally",
      navigator.onLine ? "ok" : "warn"
    );

    await this._bootstrapAndMigrate();
    this._startUserListener();
    return { mode: "cloud", uid: this.uid };
  }

  // A redirect sign-in leaves the page, goes to Google, and comes back. This
  // picks up the result on the way back in. It must run on every load, because
  // there is no way to know in advance whether we are mid-redirect.
  async _completeRedirect() {
    const { auth, getRedirectResult, GoogleAuthProvider, signInWithRedirect } = this.fb;
    try {
      const cred = await getRedirectResult(auth);
      if (cred?.user) {
        sessionStorage.removeItem("fuellog:redirecting");
        this._setStatus("Synced to " + (cred.user.email || "Google"), "ok");
      }
      return cred?.user || null;
    } catch (e) {
      // The Google account already owns a different uid, so it can't be linked
      // to this anonymous one. Sign in to the existing account instead.
      if (
        e.code === "auth/credential-already-in-use" ||
        e.code === "auth/email-already-in-use" ||
        e.code === "auth/account-exists-with-different-credential"
      ) {
        this._redirectConflict = true;
        if (!sessionStorage.getItem("fuellog:switching")) {
          sessionStorage.setItem("fuellog:switching", "1");
          await signInWithRedirect(auth, new GoogleAuthProvider());
        }
        return null;
      }
      console.warn("redirect sign-in did not complete", e);
      sessionStorage.removeItem("fuellog:redirecting");
      this._redirectError = e;
      return null;
    }
  }

  // Creates the user doc on first run and lifts any existing localStorage data
  // into Firestore exactly once.
  async _bootstrapAndMigrate() {
    const { getDoc, writeBatch, doc, db, serverTimestamp } = this.fb;

    let snap;
    try {
      snap = await getDoc(this._userRef);
    } catch (e) {
      this._setStatus("Cannot reach database — check rules", "warn");
      console.error("Firestore read failed. Did you publish firestore.rules?", e);
      throw e;
    }

    if (snap.exists() && snap.data().migratedAt) return;

    const localGoals = loadJSON(GOALS_KEY, null);
    const localFoods = loadJSON(PRESETS_KEY, null);
    const dayKeys = Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX + "log:"))
      .map((k) => k.slice((PREFIX + "log:").length));

    const batch = writeBatch(db);

    batch.set(
      this._userRef,
      {
        goals: localGoals || DEFAULT_GOALS,
        recent: [],
        createdAt: snap.exists() ? snap.data().createdAt || serverTimestamp() : serverTimestamp(),
        migratedAt: serverTimestamp(),
      },
      { merge: true }
    );

    for (const f of localFoods || DEFAULT_FOODS) {
      batch.set(doc(db, "users", this.uid, "foods", f.id || newId("p")), foodPayload(f));
    }

    let writes = 0;
    for (const dayKey of dayKeys) {
      for (const e of loadJSON(dayStorageKey(dayKey), [])) {
        if (writes >= 400) break; // stay under the 500-op batch limit
        batch.set(doc(db, "users", this.uid, "days", dayKey, "entries", e.id || newId("e")), entryPayload(e));
        writes++;
      }
    }

    await batch.commit();
    console.info(`Migrated ${dayKeys.length} day(s) and ${(localFoods || DEFAULT_FOODS).length} food(s) to Firestore.`);
  }

  // Goals and the recent list live on the same document, so they share one
  // listener rather than paying for two.
  _startUserListener() {
    this.fb.onSnapshot(
      this._userRef,
      (snap) => {
        this._userData = snap.data() || {};
        this._userLoaded = true;
        for (const sub of this._userSubs) sub(this._userData);
      },
      (err) => console.error("user listener", err)
    );
  }

  _subscribeUser(fn) {
    this._userSubs.push(fn);
    if (this._userLoaded) fn(this._userData);
  }

  onGoals(cb) {
    this._subscribeUser((d) => cb({ ...DEFAULT_GOALS, ...(d.goals || {}) }));
  }

  onRecent(cb) {
    this._subscribeUser((d) => cb(Array.isArray(d.recent) ? d.recent : []));
  }

  onFoods(cb) {
    const { onSnapshot, collection, db } = this.fb;
    onSnapshot(
      collection(db, "users", this.uid, "foods"),
      (qs) => cb(qs.docs.map((d) => normalizeFood({ id: d.id, ...d.data() })).filter(Boolean)),
      (err) => console.error("foods listener", err)
    );
  }

  watchDay(dayKey, cb) {
    const { onSnapshot, collection, query, orderBy, db } = this.fb;
    return onSnapshot(
      query(collection(db, "users", this.uid, "days", dayKey, "entries"), orderBy("at")),
      (qs) => cb(qs.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => console.error("day listener", err)
    );
  }

  async getDayEntries(dayKey) {
    const { getDocs, collection, query, orderBy, db } = this.fb;
    const qs = await getDocs(
      query(collection(db, "users", this.uid, "days", dayKey, "entries"), orderBy("at"))
    );
    return qs.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  async setGoals(goals) {
    await this.fb.setDoc(this._userRef, { goals }, { merge: true });
  }

  async addEntry(dayKey, entry) {
    const { doc, setDoc, db } = this.fb;
    await setDoc(doc(db, "users", this.uid, "days", dayKey, "entries", newId("e")), entryPayload(entry));
    return 1;
  }

  async addEntries(dayKey, entries) {
    if (entries.length === 0) return 0;
    const { doc, writeBatch, db } = this.fb;
    const batch = writeBatch(db);
    const slice = entries.slice(0, 400);
    for (const e of slice) {
      batch.set(doc(db, "users", this.uid, "days", dayKey, "entries", newId("e")), entryPayload(e));
    }
    await batch.commit();
    return slice.length;
  }

  async removeEntry(dayKey, entryId) {
    const { doc, deleteDoc, db } = this.fb;
    await deleteDoc(doc(db, "users", this.uid, "days", dayKey, "entries", entryId));
  }

  async copyDay(fromKey, toKey) {
    const src = await this.getDayEntries(fromKey);
    if (src.length === 0) return 0;
    const now = Date.now();
    const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return this.addEntries(toKey, src.map((e) => ({ ...e, at: now, time })));
  }

  async addFood(food) {
    const { doc, setDoc, db } = this.fb;
    const id = food.id || newId("p");
    await setDoc(doc(db, "users", this.uid, "foods", id), foodPayload({ ...food, logCount: 1 }));
    return id;
  }

  async updateFood(id, patch) {
    const { doc, getDoc, setDoc, db } = this.fb;
    const ref = doc(db, "users", this.uid, "foods", id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    await setDoc(ref, foodPayload({ ...normalizeFood(snap.data()), ...patch }));
  }

  async deleteFood(id) {
    const { doc, deleteDoc, db } = this.fb;
    await deleteDoc(doc(db, "users", this.uid, "foods", id));
  }

  async bumpFood(id) {
    const { doc, updateDoc, increment, db } = this.fb;
    try {
      await updateDoc(doc(db, "users", this.uid, "foods", id), {
        logCount: increment(1),
        lastUsed: Date.now(),
      });
    } catch {
      /* food was deleted mid-tap; not worth surfacing */
    }
  }

  async noteRecent(food) {
    const next = mergeRecent(this._userData.recent || [], food);
    await this.fb.setDoc(this._userRef, { recent: next }, { merge: true });
  }

  // The barcode cache is shared across all users of the app, so the second
  // scan of a given product anywhere is instant and works offline.
  async getCachedBarcode(upc) {
    const { doc, getDoc, db } = this.fb;
    try {
      const snap = await getDoc(doc(db, "barcodes", String(upc)));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      console.warn("barcode cache read failed", e);
      return null;
    }
  }

  async cacheBarcode(upc, data) {
    const { doc, setDoc, db } = this.fb;
    try {
      // The key list here must match firestore.rules exactly or this is
      // rejected. Failing quietly is fine — it is only a cache.
      await setDoc(doc(db, "barcodes", String(upc)), data);
    } catch (e) {
      console.warn("barcode cache write refused", e);
    }
  }

  // Anonymous accounts die with the browser's storage. Linking to Google keeps
  // the same uid and therefore the same data, on any device.
  //
  // iOS Safari blocks the popup no matter how it's triggered, so a blocked
  // popup falls back to a full-page redirect. The page leaves, comes back, and
  // _completeRedirect() picks up the result on the next load.
  async signInWithGoogle() {
    const {
      auth, GoogleAuthProvider, linkWithPopup, signInWithPopup,
      linkWithRedirect, signInWithRedirect,
    } = this.fb;

    const POPUP_UNAVAILABLE = [
      "auth/popup-blocked",
      "auth/popup-closed-by-user",
      "auth/cancelled-popup-request",
      "auth/operation-not-supported-in-this-environment",
      "auth/web-storage-unsupported",
    ];

    const provider = () => new GoogleAuthProvider();

    try {
      const cred = await linkWithPopup(auth.currentUser, provider());
      this._setStatus("Synced to " + (cred.user.email || "Google"), "ok");
      return { user: cred.user, redirecting: false };
    } catch (e) {
      if (POPUP_UNAVAILABLE.includes(e.code)) {
        sessionStorage.setItem("fuellog:redirecting", "1");
        await linkWithRedirect(auth.currentUser, provider());
        return { user: null, redirecting: true };
      }

      // Already linked, or that Google account owns a different uid.
      if (
        e.code === "auth/credential-already-in-use" ||
        e.code === "auth/email-already-in-use" ||
        e.code === "auth/provider-already-linked"
      ) {
        try {
          const cred = await signInWithPopup(auth, provider());
          this._setStatus("Synced to " + (cred.user.email || "Google"), "ok");
          return { user: cred.user, redirecting: false };
        } catch (e2) {
          if (POPUP_UNAVAILABLE.includes(e2.code)) {
            sessionStorage.setItem("fuellog:redirecting", "1");
            await signInWithRedirect(auth, provider());
            return { user: null, redirecting: true };
          }
          throw e2;
        }
      }
      throw e;
    }
  }

  currentUser() {
    return this.fb.auth.currentUser;
  }

  redirectPending() {
    return !!sessionStorage.getItem("fuellog:redirecting");
  }

  redirectError() {
    return this._redirectError || null;
  }
}

/* ------------------------------------------------------------------ *
 * Backend selection
 * ------------------------------------------------------------------ */

async function loadFirebase() {
  const base = `https://www.gstatic.com/firebasejs/${SDK}`;
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
  ]);

  const app = appMod.initializeApp(firebaseConfig);

  // Offline persistence is the whole reason this feels instant in a dining hall
  // basement. Writes queue on device and flush when signal comes back.
  const db = fsMod.initializeFirestore(app, {
    localCache: fsMod.persistentLocalCache({
      tabManager: fsMod.persistentMultipleTabManager(),
    }),
  });

  return {
    db,
    auth: authMod.getAuth(app),
    onAuthStateChanged: authMod.onAuthStateChanged,
    signInAnonymously: authMod.signInAnonymously,
    GoogleAuthProvider: authMod.GoogleAuthProvider,
    linkWithPopup: authMod.linkWithPopup,
    signInWithPopup: authMod.signInWithPopup,
    linkWithRedirect: authMod.linkWithRedirect,
    signInWithRedirect: authMod.signInWithRedirect,
    getRedirectResult: authMod.getRedirectResult,
    doc: fsMod.doc,
    collection: fsMod.collection,
    query: fsMod.query,
    orderBy: fsMod.orderBy,
    getDoc: fsMod.getDoc,
    getDocs: fsMod.getDocs,
    setDoc: fsMod.setDoc,
    updateDoc: fsMod.updateDoc,
    deleteDoc: fsMod.deleteDoc,
    onSnapshot: fsMod.onSnapshot,
    writeBatch: fsMod.writeBatch,
    increment: fsMod.increment,
    serverTimestamp: fsMod.serverTimestamp,
  };
}

export async function createStore() {
  if (!isConfigured) {
    console.info("firebase-config.js still has placeholders — running on localStorage.");
    const local = new LocalStore();
    await local.init();
    return local;
  }
  try {
    const fb = await loadFirebase();
    const cloud = new CloudStore(fb);
    await cloud.init();
    return cloud;
  } catch (e) {
    console.error("Firebase failed to start, falling back to localStorage.", e);
    const local = new LocalStore();
    local.fellBack = true;
    await local.init();
    return local;
  }
}
