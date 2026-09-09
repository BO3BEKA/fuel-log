// scanner.js — camera barcode scanning that works on iOS.
//
// Two paths, because Safari doesn't implement the native BarcodeDetector API:
//   1. BarcodeDetector — Chrome on Android and desktop. Fast, cheap, no download.
//   2. ZXing from a CDN — everything else, including every iPhone and iPad.
//
// iOS specifics that will otherwise waste your afternoon:
//   * HTTPS is required. GitHub Pages is fine, plain http://localhost is fine,
//     anything else on http:// silently gets no camera.
//   * The <video> element needs `playsinline` and `muted` or Safari yanks it
//     into its own fullscreen player.
//   * getUserMedia must be triggered by a real tap. Calling it on page load
//     gets rejected.
//   * Add to Home Screen (standalone mode) works from iOS 14.3 on.

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/+esm';

const FORMATS_NATIVE = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

const VIDEO_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
};

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export function secureEnough() {
  return window.isSecureContext || location.hostname === 'localhost' || location.protocol === 'https:';
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

// Starts the camera and calls onResult(code) the first time it reads a barcode.
// Returns a handle: { stop(), setTorch(bool), torchAvailable }
export async function startScanner({ video, onResult, onStatus }) {
  if (!secureEnough()) throw new Error('Camera needs HTTPS. Open the site over https:// and try again.');
  if (!cameraSupported()) throw new Error('This browser will not give a web page camera access.');

  video.setAttribute('playsinline', 'true');
  video.setAttribute('muted', 'true');
  video.muted = true;

  const native = 'BarcodeDetector' in window;
  onStatus?.(native ? 'Starting camera…' : 'Loading scanner…');

  let handle;
  if (native) {
    handle = await startNative({ video, onResult, onStatus });
  } else {
    handle = await startZXing({ video, onResult, onStatus });
  }
  return handle;
}

/* ------------------------------------------------------------------ *
 * Path 1: native BarcodeDetector
 * ------------------------------------------------------------------ */

async function startNative({ video, onResult, onStatus }) {
  let supported = FORMATS_NATIVE;
  try {
    const avail = await window.BarcodeDetector.getSupportedFormats();
    supported = FORMATS_NATIVE.filter((f) => avail.includes(f));
    if (!supported.length) supported = avail;
  } catch { /* older implementations lack getSupportedFormats */ }

  const detector = new window.BarcodeDetector({ formats: supported });
  const stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
  video.srcObject = stream;
  await video.play();
  onStatus?.('Point at the barcode');

  let stopped = false;
  let raf = null;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length && codes[0].rawValue) {
        const value = String(codes[0].rawValue).replace(/\D/g, '');
        if (value.length >= 8) {
          handle.stop();
          onResult(value);
          return;
        }
      }
    } catch { /* detect throws while the video has no frame yet */ }
    // ~8 fps is plenty and keeps the phone cool.
    timer = setTimeout(() => { raf = requestAnimationFrame(tick); }, 120);
  };

  const handle = makeHandle(stream, () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    if (timer) clearTimeout(timer);
    video.srcObject = null;
  });

  raf = requestAnimationFrame(tick);
  return handle;
}

/* ------------------------------------------------------------------ *
 * Path 2: ZXing (iOS Safari and anything else without BarcodeDetector)
 * ------------------------------------------------------------------ */

async function startZXing({ video, onResult, onStatus }) {
  let lib;
  try {
    lib = await import(/* @vite-ignore */ ZXING_URL);
  } catch (e) {
    throw new Error('Could not load the scanner library. Check your connection.');
  }

  const { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } = lib;

  // Restricting formats makes decoding noticeably faster and cuts misreads.
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);

  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });

  onStatus?.('Starting camera…');
  let settled = false;

  await reader.decodeFromConstraints(VIDEO_CONSTRAINTS, video, (result, err) => {
    if (settled) return;
    if (result) {
      const value = String(result.getText()).replace(/\D/g, '');
      if (value.length >= 8) {
        settled = true;
        handle.stop();
        onResult(value);
      }
    }
    // err fires constantly for "no barcode in this frame" — that is normal and
    // must not be surfaced.
  });

  onStatus?.('Point at the barcode');

  const stream = video.srcObject;
  const handle = makeHandle(stream, () => {
    settled = true;
    try { reader.reset(); } catch { /* already torn down */ }
    video.srcObject = null;
  });

  return handle;
}

/* ------------------------------------------------------------------ *
 * Shared handle: stop, and torch where the browser allows it
 * ------------------------------------------------------------------ */

function makeHandle(stream, cleanup) {
  const track = stream?.getVideoTracks?.()[0] || null;
  const caps = track?.getCapabilities?.() || {};
  let torchOn = false;
  let stopped = false;

  return {
    // Safari does not expose torch to web pages, so this is Chrome-only.
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
