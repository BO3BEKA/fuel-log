// scanner.js — camera barcode scanning.
//
// Bump this when the file changes. It shows in the scanner's diagnostics line,
// so there is never any doubt about which build is actually live.
export const SCANNER_BUILD = 'scanner-v4';

// WHAT WAS WRONG IN v3, because it is a trap worth recording:
//
//   1. It called reader.decodeFromCanvas(). That method does not exist on
//      BrowserMultiFormatReader in this version of ZXing. The live loop
//      therefore never decoded a single frame.
//   2. The obvious replacement, handing canvas pixels to RGBLuminanceSource,
//      also fails. Despite the name it does NOT accept RGBA — it wants one
//      byte of luminance per pixel. Passing RGBA returns NotFoundException on
//      every frame, which looks identical to "no barcode in view".
//
// The working path, verified against generated EAN-13 images including a
// deliberately blurred one:
//
//   canvas -> getImageData -> convert to grayscale -> RGBLuminanceSource
//          -> HybridBinarizer -> BinaryBitmap -> MultiFormatReader.decode
//
// A barcode is also decoded from a cropped region matching the on-screen
// reticle, and from a 90-degree rotated copy on alternate frames, because a
// 1D barcode read by horizontal scan lines cannot be decoded when it is held
// vertically.

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

// Matches the .scan-reticle box in the page, so the crop is what you aim at.
const CROP = { top: 0.22, bottom: 0.78, left: 0.10, right: 0.90 };

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
export function secureEnough() {
  return window.isSecureContext || location.hostname === 'localhost' || location.protocol === 'https:';
}

const cleanCode = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const plausible = (c) => c.length === 8 || c.length === 12 || c.length === 13 || c.length === 14;

/* ------------------------------------------------------------------ *
 * ZXing decoder
 * ------------------------------------------------------------------ */

let zxingPromise = null;
function loadZXing() {
  if (!zxingPromise) {
    zxingPromise = import(/* @vite-ignore */ ZXING_URL).catch((e) => {
      zxingPromise = null;
      throw new Error('Could not load the scanner library (' + (e.message || 'network') + ')');
    });
  }
  return zxingPromise;
}

let decoderPromise = null;

// Builds a decoder from ZXing's core classes rather than its browser wrappers,
// because the core API is stable across versions and the wrappers are not.
function getDecoder() {
  if (decoderPromise) return decoderPromise;

  decoderPromise = loadZXing().then((z) => {
    const missing = ['MultiFormatReader', 'BinaryBitmap', 'HybridBinarizer', 'RGBLuminanceSource',
                     'DecodeHintType', 'BarcodeFormat'].filter((n) => !z[n]);
    if (missing.length) throw new Error('Scanner library is missing: ' + missing.join(', '));

    const hints = new Map();
    hints.set(z.DecodeHintType.POSSIBLE_FORMATS, [
      z.BarcodeFormat.EAN_13, z.BarcodeFormat.EAN_8,
      z.BarcodeFormat.UPC_A, z.BarcodeFormat.UPC_E,
      z.BarcodeFormat.CODE_128, z.BarcodeFormat.CODE_39, z.BarcodeFormat.ITF,
    ]);
    hints.set(z.DecodeHintType.TRY_HARDER, true);

    const reader = new z.MultiFormatReader();
    reader.setHints(hints);

    return {
      name: 'ZXing core',
      // imageData is a standard canvas ImageData.
      decode(imageData) {
        const { data, width, height } = imageData;
        // One luminance byte per pixel. This conversion is the whole fix.
        const gray = new Uint8ClampedArray(width * height);
        for (let i = 0, j = 0; i < data.length; i += 4, j++) {
          gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
        }
        const src = new z.RGBLuminanceSource(gray, width, height);
        const bitmap = new z.BinaryBitmap(new z.HybridBinarizer(src));
        try {
          return cleanCode(reader.decode(bitmap).getText());
        } catch {
          return ''; // NotFoundException on a frame with no barcode is normal
        } finally {
          reader.reset();
        }
      },
    };
  }).catch((e) => {
    decoderPromise = null;
    throw e;
  });

  return decoderPromise;
}

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const avail = await window.BarcodeDetector.getSupportedFormats();
    // Chrome on Windows advertises the API but supports no 1D formats.
    const usable = FORMATS_NATIVE.filter((f) => avail.includes(f));
    if (!usable.length) return null;
    return new window.BarcodeDetector({ formats: usable });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Frame capture
 * ------------------------------------------------------------------ */

function drawRegion(source, canvas, sw, sh, rotate, scale = 1) {
  const sx = Math.floor(sw * CROP.left);
  const sy = Math.floor(sh * CROP.top);
  const cw = Math.floor(sw * (CROP.right - CROP.left));
  const ch = Math.floor(sh * (CROP.bottom - CROP.top));
  if (cw < 24 || ch < 24) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const dw = Math.round(cw * scale);
  const dh = Math.round(ch * scale);

  if (rotate) {
    canvas.width = dh;
    canvas.height = dw;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(source, sx, sy, cw, ch, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  } else {
    canvas.width = dw;
    canvas.height = dh;
    ctx.drawImage(source, sx, sy, cw, ch, 0, 0, dw, dh);
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function drawWhole(source, canvas, sw, sh, maxSide = 1600) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/* ------------------------------------------------------------------ *
 * Still images
 * ------------------------------------------------------------------ */

// A photo from the native camera is far sharper than any video frame the
// browser hands over, so this reads barcodes live scanning gives up on.
export async function decodeImageFile(file) {
  const decoder = await getDecoder();
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');

  try {
    // Whole image first, then the middle, then rotated, then zoomed. A photo
    // is worth spending several attempts on; a video frame is not.
    const attempts = [
      () => drawWhole(bitmap, canvas, bitmap.width, bitmap.height, 1600),
      () => drawWhole(bitmap, canvas, bitmap.width, bitmap.height, 2400),
      () => drawRegion(bitmap, canvas, bitmap.width, bitmap.height, false, 1),
      () => drawRegion(bitmap, canvas, bitmap.width, bitmap.height, true, 1),
      () => drawRegion(bitmap, canvas, bitmap.width, bitmap.height, false, 2),
    ];
    for (const make of attempts) {
      const img = make();
      if (!img) continue;
      const code = decoder.decode(img);
      if (plausible(code)) return code;
    }
    return null;
  } finally {
    bitmap.close?.();
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

  onStatus?.('Loading scanner…');

  const detector = await nativeDetector();
  let decoder = null;
  if (!detector) {
    try {
      decoder = await getDecoder();
    } catch (e) {
      diag.lastError = e.message;
      push();
      throw e;
    }
  }
  diag.engine = detector ? 'native BarcodeDetector' : decoder.name;
  push();

  onStatus?.('Starting camera…');
  const stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
  video.srcObject = stream;
  await video.play().catch(() => {});

  // Safari reports 0x0 for a moment after play() resolves.
  for (let i = 0; i < 40 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 50));
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
      if (!diag.resolution.includes('x')) diag.resolution = `${video.videoWidth}x${video.videoHeight}`;

      try {
        if (detector) {
          const codes = await detector.detect(video);
          const code = cleanCode(codes?.[0]?.rawValue);
          if (plausible(code)) return finish(code);
        } else {
          const img = drawRegion(video, canvas, video.videoWidth, video.videoHeight, rotatePass, 1);
          if (img) {
            const code = decoder.decode(img);
            if (plausible(code)) return finish(code);
          }
          // Alternating catches barcodes held vertically, which otherwise
          // never decode at all.
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

/* ------------------------------------------------------------------ *
 * Feedback and camera control
 * ------------------------------------------------------------------ */

// iOS Safari does not implement navigator.vibrate and no web API reaches the
// Taptic Engine, so the beep is what iPhone users actually get.
export function successFeedback() {
  try {
    if (navigator.vibrate) navigator.vibrate([45, 35, 45]);
  } catch { /* throws when backgrounded on some browsers */ }

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
