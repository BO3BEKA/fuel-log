// Firebase project config — fuel-log-99079
//
// VERIFY THE TWO LONG STRINGS BELOW before you trust this file. I read them off
// your screenshot, and in that font 1 / l / I and 0 / O are indistinguishable.
// In the console, hover the config code block, click the copy icon, and compare
// apiKey and appId against what's here. A single wrong character gives you a
// confusing auth/api-key-not-valid error later.
//
// These values are NOT secrets. They identify your project to Google and are
// visible in any browser that loads your site. Your data is protected by
// firestore.rules and by which auth providers you enable, never by hiding this
// file. Committing it to a public GitHub repo is fine and normal.

export const firebaseConfig = {
  apiKey: "AIzaSyBvU4FFG1o1X6ZA1_xVaLE_5GF08zNosBA",
  authDomain: "fuel-log-99079.firebaseapp.com",
  projectId: "fuel-log-99079",
  storageBucket: "fuel-log-99079.firebasestorage.app",
  messagingSenderId: "895299395431",
  appId: "1:895299395431:web:3a35c3bb581850a4b459c2",
};

// Your console also showed measurementId: "G-Z0GNZVJKM0" — that's Google
// Analytics. It's left out on purpose. The app never loads the analytics SDK,
// so the key would sit unused. Nothing breaks by omitting it.

// Pinned SDK version. Bump this one string to upgrade the whole app.
// Releases: https://firebase.google.com/support/release-notes/js
export const SDK = "10.12.2";

// True once every placeholder has been replaced. Until then the app runs on
// localStorage so it never hard-fails while you are mid-setup.
export const isConfigured = Object.values(firebaseConfig).every(
  (v) => typeof v === "string" && v.length > 0 && !v.includes("PASTE_")
);
