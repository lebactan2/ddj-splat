/**
 * audio.js
 * FFT analysis of a live input, and the auto-VJ routing built on top of it.
 *
 * Adapted from the mesh-sequencer project's src/audio.js — the capture and
 * band-follower half is the same; what is new here is that VVJ Splat has no
 * clock of its own to ride, so the bands drive the hydra screen-FX bank
 * directly (see AUTO_ROUTING).
 *
 * Source is whatever the browser will hand over:
 *   mic      getUserMedia — a monitor mic pointed at the room, or a loopback
 *            device (VB-Cable, BlackHole, "Stereo Mix") for the actual mix
 *   desktop  getDisplayMedia with audio — a browser tab or the whole system on
 *            Chrome; the video track is thrown away immediately
 *   file     an audio file picked from disk, played through the graph
 *
 * Levels are smoothed with an attack/release pair rather than a single time
 * constant: a kick should hit instantly and fall away over ~150ms, which one
 * symmetric filter cannot do.
 */

const FFT_SIZE = 2048;

// Band edges in Hz. Low is the kick/bass region, mid the body of most
// instruments, high the hats and air that give the fast flicker.
const BANDS = [
  { name: 'low', from: 20, to: 250 },
  { name: 'mid', from: 250, to: 2000 },
  { name: 'high', from: 2000, to: 16000 },
];

const ATTACK = 0.55;    // per-frame rise fraction toward a louder reading
const RELEASE = 0.12;   // per-frame fall fraction toward a quieter one

/**
 * Auto-VJ routing: which band drives which hydra op, and how far at full depth.
 * These are ADDED to whatever the knobs are set to and clamped at 1, so the
 * bank stays playable by hand while the music rides on top — turn the AUTO
 * depth to zero and the knobs are exactly what they were.
 *
 * Chosen so a track reads as motion rather than as chaos: the kick warps the
 * frame, the body of the mix pushes hue, hats add a fast pixel shimmer, and a
 * detected kick onset punches a brief threshold flash.
 */
export const AUTO_ROUTING = [
  { band: 'low', op: 'modulate', amount: 0.55 },
  { band: 'low', op: 'kaleid', amount: 0.18 },
  { band: 'mid', op: 'colorama', amount: 0.5 },
  { band: 'high', op: 'pixel', amount: 0.35 },
  { band: 'onsetLow', op: 'thresh', amount: 0.4 },
];

/** Live analysis, read every frame by main.js. All values 0..1. */
export const audio = {
  on: false,
  source: 'none',       // 'mic' | 'desktop' | 'file' | 'none'
  level: 0,             // full-band loudness
  low: 0,
  mid: 0,
  high: 0,
  onsetLow: 0,          // 1 on the frame a kick lands, decaying after
  spectrum: null,       // Uint8Array(FFT_SIZE/2), raw bins for the readout
  error: '',
};

let ctx = null;
let analyser = null;
let node = null;        // whatever is currently feeding the analyser
let stream = null;
let fileEl = null;
let binHz = 0;
let bandBins = [];
// running mean of the low band, so onset detection follows the material
// instead of a fixed threshold that a quiet track never crosses
let lowAvg = 0;

function ensureContext() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = ctx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.6;
  audio.spectrum = new Uint8Array(analyser.frequencyBinCount);
  binHz = ctx.sampleRate / FFT_SIZE;
  bandBins = BANDS.map((b) => [
    Math.max(1, Math.floor(b.from / binHz)),
    Math.min(analyser.frequencyBinCount - 1, Math.ceil(b.to / binHz)),
  ]);
  return ctx;
}

function disconnect() {
  if (node) { try { node.disconnect(); } catch (e) {} node = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (fileEl) { fileEl.pause(); fileEl = null; }
}

/** Mic (or a loopback capture device selected as the default input). */
export async function startMic() {
  ensureContext();
  disconnect();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // the processing chain a call would want is exactly wrong for music
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    node = ctx.createMediaStreamSource(stream);
    node.connect(analyser);
    await ctx.resume();
    audio.on = true; audio.source = 'mic'; audio.error = '';
  } catch (e) {
    audio.on = false; audio.error = 'mic refused: ' + (e.message || e);
  }
  return audio.on;
}

/**
 * A tab's or the system's own output. Chrome only, and the user has to tick
 * "share audio" in the picker — without it the track list comes back empty,
 * which is worth saying out loud rather than silently analysing nothing.
 */
export async function startDesktop() {
  ensureContext();
  disconnect();
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());     // the picture is not wanted
    if (!stream.getAudioTracks().length) {
      disconnect();
      audio.on = false;
      audio.error = 'no audio in that capture — tick "share tab audio" in the picker';
      return false;
    }
    node = ctx.createMediaStreamSource(stream);
    node.connect(analyser);
    await ctx.resume();
    audio.on = true; audio.source = 'desktop'; audio.error = '';
  } catch (e) {
    audio.on = false; audio.error = 'capture refused: ' + (e.message || e);
  }
  return audio.on;
}

/** An audio file, played out loud and analysed on the way. */
export async function startFile(file) {
  ensureContext();
  disconnect();
  try {
    fileEl = new Audio(URL.createObjectURL(file));
    fileEl.loop = true;
    fileEl.crossOrigin = 'anonymous';
    node = ctx.createMediaElementSource(fileEl);
    node.connect(analyser);
    analyser.connect(ctx.destination);   // a file has to be audible to be useful
    await ctx.resume();
    await fileEl.play();
    audio.on = true; audio.source = 'file'; audio.error = '';
  } catch (e) {
    audio.on = false; audio.error = 'could not play that file: ' + (e.message || e);
  }
  return audio.on;
}

export function stopAudio() {
  disconnect();
  if (analyser) { try { analyser.disconnect(); } catch (e) {} }
  audio.on = false;
  audio.source = 'none';
  audio.level = audio.low = audio.mid = audio.high = audio.onsetLow = 0;
  if (audio.spectrum) audio.spectrum.fill(0);
}

/** Mean of a bin range, as 0..1. */
function bandLevel(spectrum, [lo, hi]) {
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += spectrum[i];
  return sum / ((hi - lo + 1) * 255);
}

/** Asymmetric follower: snap up, fall off slowly. */
function follow(prev, next) {
  return prev + (next - prev) * (next > prev ? ATTACK : RELEASE);
}

/**
 * One analysis frame. Called from the render loop, so it must stay cheap:
 * one getByteFrequencyData plus three range sums over 1024 bins.
 */
export function updateAudio() {
  if (!audio.on || !analyser) return;
  analyser.getByteFrequencyData(audio.spectrum);

  const raw = BANDS.map((b, i) => bandLevel(audio.spectrum, bandBins[i]));
  audio.low = follow(audio.low, raw[0]);
  audio.mid = follow(audio.mid, raw[1]);
  audio.high = follow(audio.high, raw[2]);
  audio.level = follow(audio.level, (raw[0] + raw[1] + raw[2]) / 3);

  // Onset: the low band above its own running mean by a clear margin. The mean
  // tracks slowly, so a loud track and a quiet one both give usable kicks.
  lowAvg += (raw[0] - lowAvg) * 0.05;
  const over = raw[0] - lowAvg * 1.35;
  audio.onsetLow = over > 0.02 ? Math.min(1, over * 6) : Math.max(0, audio.onsetLow - 0.12);
}

/**
 * The auto-VJ modulation for one frame: { op: extraAmount } to add on top of
 * the hydra knobs. Empty while the analyser is off or the depth is zero, so the
 * caller can skip its work entirely.
 * @param {number} depth 0..1 master amount for the whole routing
 */
export function autoVjModulation(depth) {
  const out = {};
  if (!audio.on || depth <= 0) return out;
  for (const r of AUTO_ROUTING) {
    const v = audio[r.band] || 0;
    if (v <= 0) continue;
    out[r.op] = (out[r.op] || 0) + v * r.amount * depth;
  }
  return out;
}
