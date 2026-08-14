/**
 * sogLoader.js
 * Decoder for the PlayCanvas SOGS "self-organising gaussians" splat format
 * (.sog / .ssog), version 2 (generator "splat-transform v2.x").
 *
 * Both packagings are supported:
 *   - bundled:   a .sog/.ssog ZIP archive           -> decodeSog(arrayBuffer)
 *   - unbundled: a folder of loose meta.json+.webp  -> decodeSogFromFiles(files)
 *
 * A .sog contains meta.json plus a set of WebP textures:
 *   means_l.webp, means_u.webp  — 16-bit position per axis (low + high byte)
 *   scales.webp                 — 8-bit codebook index per axis -> log scale
 *   quats.webp                  — smallest-three packed rotation quaternion
 *   sh0.webp                    — DC spherical-harmonic colour + opacity
 *   shN_*.webp                  — higher-order SH (ignored here)
 *
 * Decode math confirmed against the authoritative PlayCanvas engine reader
 * `src/scene/gsplat/gsplat-sog-data.js` (v2 path):
 *
 *   means:  n = lerp(mins[k], maxs[k], ((hi<<8)+lo)/65535)
 *           pos = sign(n) * (exp(|n|) - 1)
 *   scales: logScale = codebook[idx];   linear = exp(logScale)
 *   quats:  norm = SQRT2;  a,b,c = (byte/255 - 0.5)*norm;
 *           d = sqrt(max(0, 1 - (a*a+b*b+c*c)));  mode = byte[3] - 252;
 *           mode 0 -> (x,y,z,w)=(a,b,c,d)
 *           mode 1 -> (d,b,c,a)
 *           mode 2 -> (b,d,c,a)
 *           mode 3 -> (b,c,d,a)
 *   sh0:    SH_C0 = 0.28209479177387814
 *           colour_channel = clamp(0.5 + SH_C0 * codebook[idx], 0, 1)
 *           alpha = sh0_byte[3] / 255   (already sigmoid/0..1 space)
 *
 * Output is the app's 32-byte-per-splat ".splat" layout:
 *   position  3 x float32 (12B)
 *   scale     3 x float32 (12B, LINEAR)
 *   colour    4 x uint8   (4B, RGBA)
 *   rotation  4 x uint8   (4B, order w,x,y,z; each [-1,1]->[0,255])
 */

import { unzipSync } from 'fflate';

const SH_C0 = 0.28209479177387814;
const NORM = Math.SQRT2;

/** Decode a single WebP byte buffer to a tightly-packed RGBA Uint8ClampedArray. */
async function decodeWebpToRGBA(bytes) {
  const blob = new Blob([bytes], { type: 'image/webp' });
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;

  let ctx;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);
  if (typeof bitmap.close === 'function') bitmap.close();
  return { data: imageData.data, width, height };
}

function quaternionByte(v) {
  // [-1,1] -> [0,255], matching encodeQuaternionByte in main.js
  let b = Math.round((v * 0.5 + 0.5) * 255);
  if (b < 0) b = 0; else if (b > 255) b = 255;
  return b;
}

/** Strip any directory prefix so zip entries and picked files key alike. */
function baseName(path) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i === -1 ? path : path.slice(i + 1);
}

/** Default texture names, used when meta.json omits the `files` arrays. */
const DEFAULT_FILES = {
  means: ['means_l.webp', 'means_u.webp'],
  scales: ['scales.webp'],
  quats: ['quats.webp'],
  sh0: ['sh0.webp'],
};

/**
 * Decode a SOGS bundle already split into named byte blobs.
 * Entries may be keyed by full path (ZIP) or bare filename (picked files);
 * lookups fall back to basename matching so nested archives still resolve.
 * @param {Record<string, Uint8Array>} entries
 * @returns {Promise<Uint8Array>}
 */
export async function decodeSogEntries(entries) {
  // Basename index for the fallback lookup path.
  const byBase = new Map();
  for (const key of Object.keys(entries)) {
    const b = baseName(key).toLowerCase();
    if (!byBase.has(b)) byBase.set(b, entries[key]);
  }

  const findEntry = (name) => entries[name] ?? byBase.get(baseName(name).toLowerCase()) ?? null;

  const metaBytes = findEntry('meta.json');
  if (!metaBytes) throw new Error('SOG: meta.json not found');
  const meta = JSON.parse(new TextDecoder().decode(metaBytes));

  if (meta.version && meta.version !== 2) {
    console.warn(`[sog] meta version ${meta.version} (decoder targets v2); attempting anyway`);
  }

  const count = meta.count;
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`SOG: invalid splat count (${count})`);
  }

  const getEntry = (name) => {
    const b = findEntry(name);
    if (!b) throw new Error(`SOG: missing texture "${name}"`);
    return b;
  };

  const fileOf = (section, index) =>
    meta[section]?.files?.[index] ?? DEFAULT_FILES[section][index];

  const meansLName = fileOf('means', 0);
  const meansUName = fileOf('means', 1);
  const scalesName = fileOf('scales', 0);
  const quatsName = fileOf('quats', 0);
  const sh0Name = fileOf('sh0', 0);

  // Decode the WebP textures we need (ignore shN entirely).
  const [meansL, meansU, scalesImg, quatsImg, sh0Img] = await Promise.all([
    decodeWebpToRGBA(getEntry(meansLName)),
    decodeWebpToRGBA(getEntry(meansUName)),
    decodeWebpToRGBA(getEntry(scalesName)),
    decodeWebpToRGBA(getEntry(quatsName)),
    decodeWebpToRGBA(getEntry(sh0Name)),
  ]);

  const ml = meansL.data;
  const mu = meansU.data;
  const sc = scalesImg.data;
  const qd = quatsImg.data;
  const s0 = sh0Img.data;

  const mins = meta.means.mins;
  const maxs = meta.means.maxs;
  const minX = mins[0], minY = mins[1], minZ = mins[2];
  const spanX = maxs[0] - minX, spanY = maxs[1] - minY, spanZ = maxs[2] - minZ;

  const scaleCodebook = meta.scales.codebook;
  const sh0Codebook = meta.sh0.codebook;

  // Precompute linear scale per codebook entry: linear = exp(logScale).
  const scaleLinear = new Float32Array(scaleCodebook.length);
  for (let k = 0; k < scaleCodebook.length; k++) {
    scaleLinear[k] = Math.exp(scaleCodebook[k]);
  }
  // Precompute colour channel value per codebook entry: clamp(0.5 + SH_C0*c, 0, 1)*255.
  const colorLUT = new Uint8Array(sh0Codebook.length);
  for (let k = 0; k < sh0Codebook.length; k++) {
    let v = 0.5 + SH_C0 * sh0Codebook[k];
    if (v < 0) v = 0; else if (v > 1) v = 1;
    colorLUT[k] = Math.round(v * 255);
  }

  const out = new Uint8Array(count * 32);
  const outView = new DataView(out.buffer);

  const INV255 = 1 / 255;

  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const base = i * 32;

    // ── Position (means) ──────────────────────────────────────────────
    // 16-bit value per axis: (high << 8) + low, normalized by 65535.
    const nx = minX + spanX * (((mu[p] << 8) + ml[p]) * (1 / 65535));
    const ny = minY + spanY * (((mu[p + 1] << 8) + ml[p + 1]) * (1 / 65535));
    const nz = minZ + spanZ * (((mu[p + 2] << 8) + ml[p + 2]) * (1 / 65535));
    const px = Math.sign(nx) * (Math.exp(Math.abs(nx)) - 1);
    const py = Math.sign(ny) * (Math.exp(Math.abs(ny)) - 1);
    const pz = Math.sign(nz) * (Math.exp(Math.abs(nz)) - 1);
    outView.setFloat32(base + 0, px, true);
    outView.setFloat32(base + 4, py, true);
    outView.setFloat32(base + 8, pz, true);

    // ── Scale (codebook index -> log scale -> exp) ────────────────────
    outView.setFloat32(base + 12, scaleLinear[sc[p]], true);
    outView.setFloat32(base + 16, scaleLinear[sc[p + 1]], true);
    outView.setFloat32(base + 20, scaleLinear[sc[p + 2]], true);

    // ── Colour + opacity (sh0 DC) ─────────────────────────────────────
    out[base + 24] = colorLUT[s0[p]];
    out[base + 25] = colorLUT[s0[p + 1]];
    out[base + 26] = colorLUT[s0[p + 2]];
    out[base + 27] = s0[p + 3]; // alpha is already 0..255 sigmoid-space

    // ── Rotation (smallest-three packing) ─────────────────────────────
    const a = (qd[p] * INV255 - 0.5) * NORM;
    const b = (qd[p + 1] * INV255 - 0.5) * NORM;
    const c = (qd[p + 2] * INV255 - 0.5) * NORM;
    const d = Math.sqrt(Math.max(0, 1 - (a * a + b * b + c * c)));
    const mode = qd[p + 3] - 252;
    let qx, qy, qz, qw;
    switch (mode) {
      case 0: qx = a; qy = b; qz = c; qw = d; break;
      case 1: qx = d; qy = b; qz = c; qw = a; break;
      case 2: qx = b; qy = d; qz = c; qw = a; break;
      case 3: qx = b; qy = c; qz = d; qw = a; break;
      default: qx = a; qy = b; qz = c; qw = d; break;
    }
    // Output order matches encodeUncompressedSplatArray: w, x, y, z
    out[base + 28] = quaternionByte(qw);
    out[base + 29] = quaternionByte(qx);
    out[base + 30] = quaternionByte(qy);
    out[base + 31] = quaternionByte(qz);
  }

  return out;
}

/**
 * Decode a bundled SOGS (.sog/.ssog) ZIP archive.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<Uint8Array>}
 */
export async function decodeSog(arrayBuffer) {
  return decodeSogEntries(unzipSync(new Uint8Array(arrayBuffer)));
}

/** True if this set of picked/dropped files looks like an unbundled SOG. */
export function looksLikeUnbundledSog(files) {
  let hasMeta = false;
  let hasWebp = false;
  for (const f of files) {
    const n = baseName(f.name).toLowerCase();
    if (n === 'meta.json') hasMeta = true;
    else if (n.endsWith('.webp')) hasWebp = true;
  }
  return hasMeta && hasWebp;
}

/**
 * Decode an unbundled SOGS export: a loose meta.json plus its .webp textures,
 * as produced by `splat-transform` when writing to a directory. Files are
 * keyed by basename, so it does not matter whether they arrive from a folder
 * pick, a multi-file selection, or a directory drop.
 * @param {File[]|FileList} files
 * @returns {Promise<Uint8Array>}
 */
export async function decodeSogFromFiles(files) {
  const list = Array.from(files);
  const entries = {};
  await Promise.all(list.map(async (f) => {
    const name = baseName(f.name).toLowerCase();
    // Only meta.json and the textures are needed; skip everything else so a
    // whole-folder drop containing e.g. a preview image still works.
    if (name !== 'meta.json' && !name.endsWith('.webp')) return;
    entries[name] = new Uint8Array(await f.arrayBuffer());
  }));

  if (!entries['meta.json']) {
    throw new Error('SOG: no meta.json among the selected files — pick the whole SOG folder (meta.json + .webp textures), not just an image.');
  }
  return decodeSogEntries(entries);
}
