// scanner.js — camera barcode scanning that works on iOS.
//
// Three routes, most reliable last:
//   1. BarcodeDetector      — Chrome on Android / ChromeOS / macOS. Fast, native.
//   2. ZXing live video      — everything else, including all iPhones and iPads.
//   3. Photo capture         — hands the job to the phone's real camera app,
//                              which has proper autofocus, then decodes the
//                              still. Slower, but it reads barcodes that live
//                              video cannot.
//
// Route 3 exists because live-video decoding is genuinely hard: laptop webcams
// are fixed-focus and low resolution, and phone video streams are downscaled
// well below what the camera sensor can do. A still photo from the native
// camera is sharper than any frame the browser will hand us.
//
// iOS specifics worth knowing:
//   * HTTPS required. GitHub Pages is fine; plain http:// silently gets nothing.
//   * The <video> element needs `playsinline` and `muted` or Safari hijacks it
//     into its own fullscreen player.
//   * getUserMedia must come from a real tap, not from page load.
//   * Safari does not expose the torch to web pages. That button stays hidden.

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/+esm';

const FORMATS_NATIVE = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

const VIDEO_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
};

let zxingPromise = null;

// Cached so the second scan doesn't re-download the library.
function loadZXing() {
  if (!zxingPromise) {
    zxingPromise = import(/* @vite-ignore */ ZXING_URL).catch((e) => {
      zxingPromise = null;
      throw new Error('Could not load the scanner library. Check your connection.');
    });
  }
  return zxingPromise;
}

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export function secureEnough() {
  return window.isSecureContext || location.hostname === 'localhost' || location.protocol === 'https:';
}

async function nativeUsable() {
  if (!('BarcodeDetector' in window)) return false;
  try {
    const avail = await window.BarcodeDetector.getSupportedFormats();
    // Chrome on Windows reports the API but supports no 1D formats.
    return FORMATS_NATIVE.some((f) => avail.includes(f));
  } catch {
    return false;
  }
}

function zxingHints(lib) {
  const { DecodeHintType, BarcodeFormat } = lib;
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return hints;
}

const cleanCode = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/* ------------------------------------------------------------------ *
 * Route 3: decode a still photo
 * ------------------------------------------------------------------ */

// Takes a File from <input type="file" capture="environment"> and decodes it.
// Returns the digits, or null if nothing readable is in the image.
export async function decodeImageFile(file) {
  const lib = await loadZXing();
  const { BrowserMultiFormatReader } = lib;
  const reader = new BrowserMultiFormatReader(zxingHints(lib));
  const url = URL.createObjectURL(file);
  try {
    const result = await reader.decodeFromImageUrl(url);
    const code = cleanCode(result?.getText?.());
    return code.length >= 8 ? code : null;
  } catch {
    return null; // ZXing throws NotFoundException when there's no barcode
  } finally {
    URL.revokeObjectURL(url);
    try { reader.reset(); } catch { /* nothing to do */ }
  }
}

/* ------------------------------------------------------------------ *
 * Live scanning
 * ------------------------------------------------------------------ */

// Starts the camera and calls onResult(code) the first time it reads a barcode.
// Returns { stop(), setTorch(on), torchAvailable, torchOn, engine }
export async function startScanner({ video, onResult, onStatus, onProgress }) {
  if (!secureEnough()) throw new Error('The camera needs an https:// address.');
  if (!cameraSupported()) throw new Error('This browser will not give a web page camera access.');

  video.setAttribute('playsinline', 'true');
  video.setAttribute('autoplay', 'true');
  video.setAttribute('muted', 'true');
  video.muted = true;

  const useNative = await nativeUsable();
  onStatus?.(useNative ? 'Starting camera…' : 'Loading scanner…');

  return useNative
    ? startNative({ video, onResult, onStatus, onProgress })
    : startZXing({ video, onResult, onStatus, onProgress });
}

// Continuous autofocus makes a large difference on Android and is harmless
// where it isn't supported.
async function nudgeFocus(track) {
  if (!track?.applyConstraints) return;
  const caps = track.getCapabilities?.() || {};
  const advanced = [];
  if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
    advanced.push({ focusMode: 'continuous' });
  }
  if (advanced.length) {
    try { await track.applyConstraints({ advanced }); } catch { /* optional */ }
  }
}

async function startNative({ video, onResult, onStatus, onProgress }) {
  const detector = new window.BarcodeDetector({ formats: FORMATS_NATIVE });
  const stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
  video.srcObject = stream;
  await video.play().catch(() => {});
  await nudgeFocus(stream.getVideoTracks()[0]);

  let stopped = false;
  let timer = null;
  let frames = 0;

  // `handle` must exist before any callback can reference it.
  const handle = makeHandle(stream, 'native', () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    video.srcObject = null;
  });

  const tick = async () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      try {
        const codes = await detector.detect(video);
        const code = cleanCode(codes?.[0]?.rawValue);
        if (code.length >= 8) {
          handle.stop();
          onResult(code);
          return;
        }
      } catch { /* detect throws on frames it can't use */ }
      frames++;
      if (frames % 8 === 0) onProgress?.(frames);
    }
    timer = setTimeout(tick, 130); // ~8fps keeps the phone cool
  };

  onStatus?.('Point at the barcode');
  tick();
  return handle;
}

async function startZXing({ video, onResult, onStatus, onProgress }) {
  const lib = await loadZXing();
  const { BrowserMultiFormatReader } = lib;

  // Passing only hints avoids a constructor signature difference between
  // ZXing versions.
  const reader = new BrowserMultiFormatReader(zxingHints(lib));

  let settled = false;
  let frames = 0;
  // Declared up front. The decode callback can fire before
  // decodeFromConstraints resolves, and referencing a `const` from later in
  // the function would throw a reference error and kill decoding silently.
  let handle = null;

  onStatus?.('Starting camera…');

  await reader.decodeFromConstraints(VIDEO_CONSTRAINTS, video, (result, err) => {
    if (settled) return;
    if (result) {
      const code = cleanCode(result.getText?.());
      if (code.length >= 8) {
        settled = true;
        if (handle) handle.stop();
        else { try { reader.reset(); } catch { /* nothing to do */ } }
        onResult(code);
        return;
      }
    }
    // err fires on every frame with no barcode in it. That is normal and must
    // never be surfaced, but it is a useful liveness signal.
    frames++;
    if (frames % 10 === 0) onProgress?.(frames);
  });

  const stream = video.srcObject;
  await nudgeFocus(stream?.getVideoTracks?.()[0]);

  handle = makeHandle(stream, 'zxing', () => {
    settled = true;
    try { reader.reset(); } catch { /* already torn down */ }
    video.srcObject = null;
  });

  onStatus?.('Point at the barcode');
  return handle;
}

/* ------------------------------------------------------------------ *
 * Shared handle
 * ------------------------------------------------------------------ */

function makeHandle(stream, engine, cleanup) {
  const track = stream?.getVideoTracks?.()[0] || null;
  const caps = track?.getCapabilities?.() || {};
  let torchOn = false;
  let stopped = false;

  return {
    engine,
    torchAvailable: !!caps.torch,

    async setTorch(on) {
      if (!track || !caps.torch) return false;
      try {
        await track.applyConstraints({ advanced: [{ torch: !!on }] });
        torchOn = !!on;
        return true;
      } catch {
        return false;
      }
    },

    get torchOn() { return torchOn; },

    stop() {
      if (stopped) return;
      stopped = true;
      try { cleanup(); } catch { /* nothing useful to do */ }
      // Releasing every track is what turns the camera light off.
      try { stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* already gone */ }
    },
  };
}
