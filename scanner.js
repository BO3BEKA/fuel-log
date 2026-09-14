// scanner.js — camera barcode scanning.
//
// BUILD marker: bump this when changing the file. It's shown in the scanner's
// diagnostics line so there is never any doubt about which version is live on
// the site, which matters when GitHub Pages serves a stale cached copy.
export const SCANNER_BUILD = 'scanner-v3';

// Why this drives its own decode loop instead of using ZXing's
// decodeFromConstraints helper:
//
//   1. Cropping. A 1D barcode is decoded by scanning horizontal lines across
//      the image. Handing ZXing the whole 1920x1080 frame means the barcode
//      occupies a small band and most scan lines hit packaging instead. We
//      crop to the region inside the on-screen reticle, so what you aim at is
//      exactly what gets decoded. This alone is a large accuracy win.
//   2. Rotation. A barcode held vertically will not decode from horizontal
//      scan lines. Every other pass runs against a 90-degree rotated copy.
//   3. Visibility. The helper hides the loop, so a stalled decoder looks
//      identical to "no barcode in view". Here every pass is counted and
//      reported.

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

// Matches the .scan-reticle box in the page, so the crop is what the user aims at.
const CROP = { top: 0.22, bottom: 0.78, left: 0.10, right: 0.90 };

let zxingPromise = null;
function loadZXing() {
  if (!zxingPromise) {
    zxingPromise = import(/* @vite-ignore */ ZXING_URL).catch((e) => {
      zxingPromise = null;
      throw new Error('Could not load the scanner library (' + (e.message || 'network error') + ')');
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
    // Chrome on Windows reports the API but supports no 1D formats at all.
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
const plausible = (code) => code.length === 8 || code.length === 12 || code.length === 13 || code.length === 14;

/* ------------------------------------------------------------------ *
 * Success feedback
 * ------------------------------------------------------------------ */

// iOS Safari does not implement navigator.vibrate at all — it is Android only,
// and there is no web API that triggers the iPhone's Taptic Engine. So a short
// beep goes alongside it, which does work everywhere once the page has had a
// user gesture (opening the scanner counts).
export function successFeedback() {
  try {
    if (navigator.vibrate) navigator.vibrate([45, 35, 45]);
  } catch { /* some browsers throw when the page is backgrounded */ }

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.07);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    setTimeout(() => { try { ctx.close(); } catch { /* already closed */ } }, 400);
  } catch { /* audio is a nicety, never a failure */ }
}

/* ------------------------------------------------------------------ *
 * Frame capture
 * ------------------------------------------------------------------ */

function cropToCanvas(video, canvas, rotate) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return false;

  const sx = Math.floor(vw * CROP.left);
  const sy = Math.floor(vh * CROP.top);
  const sw = Math.floor(vw * (CROP.right - CROP.left));
  const sh = Math.floor(vh * (CROP.bottom - CROP.top));
  if (sw < 20 || sh < 20) return false;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (rotate) {
    canvas.width = sh;
    canvas.height = sw;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(video, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
  } else {
    canvas.width = sw;
    canvas.height = sh;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Still photo decoding
 * ------------------------------------------------------------------ */

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
    return null; // ZXing throws NotFoundException when there is no barcode
  } finally {
    URL.revokeObjectURL(url);
    try { reader.reset(); } catch { /* nothing to do */ }
  }
}

/* ------------------------------------------------------------------ *
 * Live scanning
 * ------------------------------------------------------------------ */

export async function startScanner({ video, canvas, onResult, onStatus, onDiag }) {
  const diag = {
    build: SCANNER_BUILD,
    secure: secureEnough(),
    hasCamera: cameraSupported(),
    engine: '—',
    resolution: '—',
    passes: 0,
    lastError: '',
  };
  const push = () => onDiag?.({ ...diag });
  push();

  if (!diag.secure) throw new Error('The camera needs an https:// address.');
  if (!diag.hasCamera) throw new Error('This browser will not give a web page camera access.');

  video.setAttribute('playsinline', 'true');
  video.setAttribute('autoplay', 'true');
  video.setAttribute('muted', 'true');
  video.muted = true;

  const useNative = await nativeUsable();
  diag.engine = useNative ? 'native BarcodeDetector' : 'ZXing';
  push();
  onStatus?.(useNative ? 'Starting camera…' : 'Loading scanner…');

  let lib = null;
  let reader = null;
  let detector = null;

  if (useNative) {
    detector = new window.BarcodeDetector({ formats: FORMATS_NATIVE });
  } else {
    lib = await loadZXing();
    reader = new lib.BrowserMultiFormatReader(zxingHints(lib));
    if (typeof reader.decodeFromCanvas !== 'function') {
      diag.lastError = 'decodeFromCanvas unavailable';
      push();
      throw new Error('The scanner library loaded but is missing the decoder this needs.');
    }
  }

  const stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
  video.srcObject = stream;
  await video.play().catch(() => {});

  // Safari reports 0x0 for a moment after play() resolves.
  for (let i = 0; i < 40 && !video.videoWidth; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  diag.resolution = video.videoWidth ? `${video.videoWidth}x${video.videoHeight}` : 'no frames';
  push();

  const track = stream.getVideoTracks()[0];
  await nudgeFocus(track);

  let stopped = false;
  let timer = null;
  let rotatePass = false;

  const handle = makeHandle(stream, diag.engine, () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    try { reader?.reset(); } catch { /* nothing to do */ }
    video.srcObject = null;
  });

  const finish = (code) => {
    handle.stop();
    successFeedback();
    onResult(code);
  };

  const tick = async () => {
    if (stopped) return;

    if (video.readyState >= 2 && video.videoWidth > 0) {
      if (!diag.resolution.includes('x')) {
        diag.resolution = `${video.videoWidth}x${video.videoHeight}`;
      }
      try {
        if (detector) {
          // The native detector handles rotation and framing itself, so give
          // it the whole frame.
          const codes = await detector.detect(video);
          const code = cleanCode(codes?.[0]?.rawValue);
          if (plausible(code)) return finish(code);
        } else if (cropToCanvas(video, canvas, rotatePass)) {
          try {
            const result = reader.decodeFromCanvas(canvas);
            const code = cleanCode(result?.getText?.());
            if (plausible(code)) return finish(code);
          } catch {
            // NotFoundException on a frame with no barcode. Expected, constant,
            // and not an error worth recording.
          }
          rotatePass = !rotatePass;
        }
        diag.passes++;
        if (diag.passes % 4 === 0) push();
      } catch (e) {
        diag.lastError = e.name || String(e);
        push();
      }
    }

    timer = setTimeout(tick, 110);
  };

  onStatus?.('Point at the barcode');
  tick();
  return handle;
}

// Continuous autofocus matters a lot for barcodes and is a no-op where the
// browser does not support it, which includes all of Safari.
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
      try { stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* already gone */ }
    },
  };
}
