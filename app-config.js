// app-config.js — public configuration that isn't Firebase.
//
// Kept separate from firebase-config.js so that file stays purely the Firebase
// project identifiers and you never have to think about which values in it mean
// what.

// A USDA FoodData Central key baked into the app, so nobody has to go and get
// their own before search works.
//
// Get one free at https://fdc.nal.usda.gov/api-key-signup.html — instant, no
// payment details.
//
// BE AWARE OF WHAT THIS IS:
//   * Your repo is public, so this key is visible to anyone who looks. That is
//     not a security hole — the key unlocks a public nutrition database and is
//     tied to no payment method and no personal data.
//   * The real cost is the rate limit. USDA allows roughly 1,000 requests per
//     hour per key. If the app gets popular, or someone copies the key, you
//     will start seeing 429s and search will stall until the hour rolls over.
//   * The app handles that gracefully: it says what happened and points at the
//     setting for a personal key, and Open Food Facts keeps working throughout
//     since it needs no key at all.
//   * Hiding it properly would mean proxying through a Cloud Function, which
//     needs outbound network access and therefore the paid Blaze plan.
//
// Leave the placeholder in place and the app simply runs without a shared key:
// search falls back to Open Food Facts alone, and anyone can still add their
// own key in Settings.
export const USDA_SHARED_KEY = "7GShtF8FI22MmB3hj7MiUelq8U1ss8WhEefhRLFC";

export const hasSharedUsdaKey =
  typeof USDA_SHARED_KEY === "string" &&
  USDA_SHARED_KEY.length > 10 &&
  !USDA_SHARED_KEY.includes("PASTE_");
