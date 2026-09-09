// store.js — the only file in the app that knows where data lives.
//
// Two interchangeable backends behind one interface:
//   LocalStore  — localStorage, same keys the app already used. No account.
//   CloudStore  — Firestore + anonymous auth, with offline persistence.
//
// The app picks CloudStore when firebase-config.js has real values, otherwise
// LocalStore. That means you can commit and deploy at any point during setup
// without the app breaking.
//
// Interface (both backends):
//   await init()                     -> { mode, uid }
//   onStatus(cb)                     -> cb({ mode, label, tone })
//   onGoals(cb)                      -> cb(goals)
//   onFoods(cb)                      -> cb([food])
//   watchDay(dayKey, cb)             -> unsubscribe(); cb([entry])
//   setGoals(goals)
//   addEntry(dayKey, entry) / removeEntry(dayKey, entryId)
//   addFood(food) / deleteFood(id) / bumpFood(id)
//   signInWithGoogle() / currentUser()

import { firebaseConfig, isConfigured, SDK } from "./firebase-config.js";

const PREFIX = "fuellog:";
const PRESETS_KEY = PREFIX + "presets";
const GOALS_KEY = PREFIX + "goals";
const dayStorageKey = (k) => PREFIX + "log:" + k;

export const DEFAULT_GOALS = { calories: 2700, protein: 155, carbs: 0, fat: 0 };

export const DEFAULT_FOODS = [
  { id: "p1", name: "Rand Dining — chicken bowl", cal: 650, pro: 45, carb: 60, fat: 18 },
  { id: "p2", name: "Rand Dining — omelet + toast", cal: 520, pro: 30, carb: 40, fat: 22 },
  { id: "p3", name: "Publix — rotisserie chicken + rice", cal: 600, pro: 50, carb: 55, fat: 15 },
  { id: "p4", name: "Publix — protein shake", cal: 250, pro: 30, carb: 12, fat: 6 },
  { id: "p5", name: "Commons — pasta station", cal: 700, pro: 25, carb: 95, fat: 20 },
  { id: "p6", name: "Protein bar", cal: 220, pro: 20, carb: 22, fat: 7 },
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

/* ------------------------------------------------------------------ *
 * LocalStore
 * ------------------------------------------------------------------ */

class LocalStore {
  constructor() {
    this.mode = "local";
    this.fellBack = false;
    this._status = null;
    this._goals = null;
    this._foods = null;
    this._day = { key: null, cb: null };
  }

  async init() {
    return { mode: "local", uid: null };
  }

  onStatus(cb) {
    this._status = cb;
    cb({
      mode: "local",
      label: this.fellBack ? "Cloud unreachable — local only" : "This device only",
      tone: this.fellBack ? "warn" : "muted",
    });
  }

  onGoals(cb) {
    this._goals = cb;
    cb(loadJSON(GOALS_KEY, DEFAULT_GOALS));
  }

  onFoods(cb) {
    this._foods = cb;
    cb(loadJSON(PRESETS_KEY, DEFAULT_FOODS));
  }

  watchDay(dayKey, cb) {
    this._day = { key: dayKey, cb };
    cb(loadJSON(dayStorageKey(dayKey), []));
    return () => {
      if (this._day.key === dayKey) this._day = { key: null, cb: null };
    };
  }

  _emitDay(dayKey) {
    if (this._day.cb && this._day.key === dayKey) {
      this._day.cb(loadJSON(dayStorageKey(dayKey), []));
    }
  }

  async setGoals(goals) {
    saveJSON(GOALS_KEY, goals);
    if (this._goals) this._goals(goals);
  }

  async addEntry(dayKey, entry) {
    const list = loadJSON(dayStorageKey(dayKey), []);
    list.push({ ...entry, id: entry.id || newId("e"), at: entry.at || Date.now() });
    saveJSON(dayStorageKey(dayKey), list);
    this._emitDay(dayKey);
  }

  async removeEntry(dayKey, entryId) {
    const list = loadJSON(dayStorageKey(dayKey), []).filter((e) => e.id !== entryId);
    saveJSON(dayStorageKey(dayKey), list);
    this._emitDay(dayKey);
  }

  async addFood(food) {
    const foods = loadJSON(PRESETS_KEY, DEFAULT_FOODS);
    foods.push({ ...food, id: food.id || newId("p"), logCount: 1, lastUsed: Date.now() });
    saveJSON(PRESETS_KEY, foods);
    if (this._foods) this._foods(foods);
  }

  async deleteFood(id) {
    const foods = loadJSON(PRESETS_KEY, DEFAULT_FOODS).filter((f) => f.id !== id);
    saveJSON(PRESETS_KEY, foods);
    if (this._foods) this._foods(foods);
  }

  async bumpFood(id) {
    const foods = loadJSON(PRESETS_KEY, DEFAULT_FOODS).map((f) =>
      f.id === id ? { ...f, logCount: (f.logCount || 0) + 1, lastUsed: Date.now() } : f
    );
    saveJSON(PRESETS_KEY, foods);
    if (this._foods) this._foods(foods);
  }

  async signInWithGoogle() {
    throw new Error("Add your Firebase config first.");
  }

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
    this.fb = fb;
    this.uid = null;
    this._status = null;
    this._statusState = { mode: "cloud", label: "Connecting", tone: "muted" };
  }

  _setStatus(label, tone) {
    this._statusState = { mode: "cloud", label, tone };
    if (this._status) this._status(this._statusState);
  }

  onStatus(cb) {
    this._status = cb;
    cb(this._statusState);
  }

  async init() {
    const { auth, onAuthStateChanged, signInAnonymously } = this.fb;

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
    this._setStatus(navigator.onLine ? "Synced" : "Offline — saving locally", navigator.onLine ? "ok" : "warn");

    await this._bootstrapAndMigrate();
    return { mode: "cloud", uid: this.uid };
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
        createdAt: snap.exists() ? snap.data().createdAt || serverTimestamp() : serverTimestamp(),
        migratedAt: serverTimestamp(),
      },
      { merge: true }
    );

    for (const f of localFoods || DEFAULT_FOODS) {
      const ref = doc(db, "users", this.uid, "foods", f.id || newId("p"));
      batch.set(ref, {
        name: f.name,
        cal: Number(f.cal) || 0,
        pro: Number(f.pro) || 0,
        carb: Number(f.carb) || 0,
        fat: Number(f.fat) || 0,
        logCount: Number(f.logCount) || 0,
        lastUsed: Number(f.lastUsed) || Date.now(),
      });
    }

    let writes = 0;
    for (const dayKey of dayKeys) {
      for (const e of loadJSON(dayStorageKey(dayKey), [])) {
        if (writes >= 400) break; // stay under the 500-op batch limit
        const ref = doc(db, "users", this.uid, "days", dayKey, "entries", e.id || newId("e"));
        batch.set(ref, {
          name: e.name,
          cal: Number(e.cal) || 0,
          pro: Number(e.pro) || 0,
          carb: Number(e.carb) || 0,
          fat: Number(e.fat) || 0,
          time: e.time || "",
          at: Number(e.at) || Date.now(),
        });
        writes++;
      }
    }

    await batch.commit();
    console.info(`Migrated ${dayKeys.length} day(s) and ${(localFoods || DEFAULT_FOODS).length} food(s) to Firestore.`);
  }

  onGoals(cb) {
    this.fb.onSnapshot(
      this._userRef,
      (snap) => cb({ ...DEFAULT_GOALS, ...(snap.data()?.goals || {}) }),
      (err) => console.error("goals listener", err)
    );
  }

  onFoods(cb) {
    const { onSnapshot, collection, db } = this.fb;
    onSnapshot(
      collection(db, "users", this.uid, "foods"),
      (qs) => cb(qs.docs.map((d) => ({ id: d.id, ...d.data() }))),
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

  async setGoals(goals) {
    await this.fb.setDoc(this._userRef, { goals }, { merge: true });
  }

  async addEntry(dayKey, entry) {
    const { doc, setDoc, db } = this.fb;
    const id = entry.id || newId("e");
    await setDoc(doc(db, "users", this.uid, "days", dayKey, "entries", id), {
      name: entry.name,
      cal: Number(entry.cal) || 0,
      pro: Number(entry.pro) || 0,
      carb: Number(entry.carb) || 0,
      fat: Number(entry.fat) || 0,
      time: entry.time || "",
      at: entry.at || Date.now(),
    });
  }

  async removeEntry(dayKey, entryId) {
    const { doc, deleteDoc, db } = this.fb;
    await deleteDoc(doc(db, "users", this.uid, "days", dayKey, "entries", entryId));
  }

  async addFood(food) {
    const { doc, setDoc, db } = this.fb;
    const id = food.id || newId("p");
    await setDoc(doc(db, "users", this.uid, "foods", id), {
      name: food.name,
      cal: Number(food.cal) || 0,
      pro: Number(food.pro) || 0,
      carb: Number(food.carb) || 0,
      fat: Number(food.fat) || 0,
      logCount: 1,
      lastUsed: Date.now(),
    });
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

  // Anonymous accounts die with the browser's storage. Linking to Google keeps
  // the same uid and therefore the same data, on any device.
  async signInWithGoogle() {
    const { auth, GoogleAuthProvider, linkWithPopup, signInWithPopup } = this.fb;
    const provider = new GoogleAuthProvider();
    try {
      const cred = await linkWithPopup(auth.currentUser, provider);
      this._setStatus("Synced to " + (cred.user.email || "Google"), "ok");
      return cred.user;
    } catch (e) {
      // Already linked, or that Google account owns a different uid already.
      if (
        e.code === "auth/credential-already-in-use" ||
        e.code === "auth/email-already-in-use" ||
        e.code === "auth/provider-already-linked"
      ) {
        const cred = await signInWithPopup(auth, provider);
        this._setStatus("Synced to " + (cred.user.email || "Google"), "ok");
        return cred.user;
      }
      throw e;
    }
  }

  currentUser() {
    return this.fb.auth.currentUser;
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
    doc: fsMod.doc,
    collection: fsMod.collection,
    query: fsMod.query,
    orderBy: fsMod.orderBy,
    getDoc: fsMod.getDoc,
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
