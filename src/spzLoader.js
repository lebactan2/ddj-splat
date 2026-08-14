/**
 * spzLoader.js
 * Decoder for the Niantic SPZ gaussian-splat container (.spz).
 *
 * Two containers exist and both are read here:
 *
 *   legacy (versions 1-3) — the whole file is a gzip stream wrapping a 16-byte
 *     header followed by six tightly packed, point-major arrays.
 *
 *       header (16B)  magic u32 = 0x5053474e ("NGSP"), version u32, numPoints u32,
 *                     shDegree u8, fractionalBits u8, flags u8, reserved u8
 *
 *   version 4 — a 32-byte plaintext header, optional extension records, a table
 *     of contents, then one independently ZSTD-compressed stream per attribute.
 *
 *       header (32B)  magic u32, version u32, numPoints u32, shDegree u8,
 *                     fractionalBits u8, flags u8, numStreams u8,
 *                     tocByteOffset u32, reserved[12]
 *       toc           numStreams x [compressedSize u64, uncompressedSize u64]
 *
 * Either way the attribute payloads are identical and appear in this order:
 *
 *   positions     numPoints * 3 * 3B  little-endian signed 24-bit fixed point
 *   alphas        numPoints * 1B      sigmoid-space opacity (0..255)
 *   colors        numPoints * 3B      SH DC coefficient, scaled by colorScale
 *   scales        numPoints * 3B      log scale, byte/16 - 10
 *   rotations     numPoints * 3B (v2) or 4B (v3+)
 *   sh            numPoints * shDim * 3B  higher-order SH (ignored here)
 *
 * Dequantisation matches Niantic's reference reader (src/cc/load-spz.cc and
 * src/cc/splat-utils.h):
 *
 *   position: i24 = b0 | b1<<8 | b2<<16 (sign extended); p = i24 / (1<<fractionalBits)
 *   scale:    logScale = byte / 16 - 10;  linear = exp(logScale)
 *   rotation: v2  "first three": xyz = byte/127.5 - 1; w = sqrt(max(0, 1 - |xyz|^2))
 *             v3+ "smallest three": u32 of 4 bytes; bits 30-31 index the omitted
 *             largest component, then three 9-bit magnitudes + sign bit each,
 *             read from the low bits downward for i = 3,2,1,0 (i.e. w,z,y,x),
 *             value = SQRT1_2 * mag / 511
 *   colour:   dc = (byte/255 - 0.5) / 0.15;  channel = clamp(0.5 + SH_C0*dc, 0, 1)
 *   alpha:    byte is already 0..255 sigmoid space, passed through
 *
 * Output is the app's 32-byte-per-splat ".splat" layout:
 *   position  3 x float32 (12B)
 *   scale     3 x float32 (12B, LINEAR)
 *   colour    4 x uint8   (4B, RGBA)
 *   rotation  4 x uint8   (4B, order w,x,y,z; each [-1,1]->[0,255])
 */

import { gunzipSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';

const SPZ_MAGIC = 0x5053474e;
const SH_C0 = 0.28209479177387814;
const COLOR_SCALE = 0.15;   // Niantic's fixed colour quantisation scale
const SQRT1_2 = Math.SQRT1_2;
const SMALLEST_THREE_MASK = (1 << 9) - 1;

/** SH coefficients per colour channel for a given SH degree. */
function shDimForDegree(degree) {
  switch (degree) {
    case 0: return 0;
    case 1: return 3;
    case 2: return 8;
    case 3: return 15;
    case 4: return 24;
    default: return -1;
  }
}

function quaternionByte(v) {
  // [-1,1] -> [0,255], matching encodeQuaternionByte in main.js
  let b = Math.round((v * 0.5 + 0.5) * 255);
  if (b < 0) b = 0; else if (b > 255) b = 255;
  return b;
}

/** Common header fields, read from either container's layout. */
function readCommonHeader(view, bytes) {
  const magic = view.getUint32(0, true);
  if (magic !== SPZ_MAGIC) {
    throw new Error(`SPZ: bad magic 0x${magic.toString(16)} (expected 0x5053474e)`);
  }
  return {
    version: view.getUint32(4, true),
    numPoints: view.getUint32(8, true),
    shDegree: bytes[12],
    fractionalBits: bytes[13],
    flags: bytes[14],
  };
}

/**
 * Split a contiguous attribute payload into per-attribute subarrays.
 * @param {Uint8Array} payload  concatenated positions..sh
 * @param {number} numPoints
 * @param {number} rotationBytes  3 for v2, 4 for v3+
 */
function sliceSections(payload, numPoints, rotationBytes) {
  const posBytes = numPoints * 9;
  const alphaBytes = numPoints;
  const colorBytes = numPoints * 3;
  const scaleBytes = numPoints * 3;
  const rotBytes = numPoints * rotationBytes;
  const needed = posBytes + alphaBytes + colorBytes + scaleBytes + rotBytes;
  if (payload.length < needed) {
    throw new Error(`SPZ: truncated payload — need ${needed} bytes for ${numPoints} splats, got ${payload.length}`);
  }

  let o = 0;
  const positions = payload.subarray(o, o += posBytes);
  const alphas = payload.subarray(o, o += alphaBytes);
  const colors = payload.subarray(o, o += colorBytes);
  const scales = payload.subarray(o, o += scaleBytes);
  const rotations = payload.subarray(o, o += rotBytes);
  return { positions, alphas, colors, scales, rotations };
}

/**
 * Read a version-4 file: plaintext header, optional extension records, a TOC of
 * (compressedSize, uncompressedSize) pairs, then that many ZSTD streams. The
 * streams concatenate back into the same payload the legacy container stores.
 */
function readV4Payload(bytes, view, header, numStreams) {
  const tocByteOffset = view.getUint32(16, true);
  if (numStreams <= 0 || numStreams > 16) {
    throw new Error(`SPZ: implausible stream count ${numStreams}`);
  }
  if (tocByteOffset + numStreams * 16 > bytes.length) {
    throw new Error('SPZ: table of contents lies outside the file');
  }

  // TOC sizes are u64; splats large enough to overflow 2^53 are not a thing,
  // so read the low half and assert the high half is zero.
  const entries = [];
  let dataOffset = tocByteOffset + numStreams * 16;
  for (let i = 0; i < numStreams; i++) {
    const base = tocByteOffset + i * 16;
    const compLo = view.getUint32(base, true);
    const compHi = view.getUint32(base + 4, true);
    const rawLo = view.getUint32(base + 8, true);
    const rawHi = view.getUint32(base + 12, true);
    if (compHi !== 0 || rawHi !== 0) throw new Error('SPZ: stream size exceeds 4 GB');
    entries.push({ offset: dataOffset, compressed: compLo, uncompressed: rawLo });
    dataOffset += compLo;
  }
  if (dataOffset > bytes.length) {
    throw new Error('SPZ: compressed streams run past the end of the file');
  }

  const total = entries.reduce((sum, e) => sum + e.uncompressed, 0);
  const payload = new Uint8Array(total);
  let write = 0;
  for (const e of entries) {
    const src = bytes.subarray(e.offset, e.offset + e.compressed);
    let raw;
    try {
      // fzstd's second argument is the destination buffer, not a length.
      raw = zstdDecompress(src, new Uint8Array(e.uncompressed));
    } catch (err) {
      throw new Error(`SPZ: ZSTD decompression failed (${err.message})`);
    }
    payload.set(raw.subarray(0, e.uncompressed), write);
    write += e.uncompressed;
  }
  return payload;
}

/**
 * Decode an SPZ ArrayBuffer into a tightly packed Uint8Array using the
 * 32-byte-per-splat layout. Higher-order SH is ignored.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Uint8Array}
 */
export function decodeSpz(arrayBuffer) {
  const raw = new Uint8Array(arrayBuffer);
  if (raw.length < 16) throw new Error('SPZ: file is too short to contain a header');

  const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;

  let bytes;
  if (isGzip) {
    try {
      bytes = gunzipSync(raw);
    } catch (e) {
      throw new Error(`SPZ: gzip decompression failed (${e.message})`);
    }
    if (bytes.length < 16) throw new Error('SPZ: file is too short to contain a header');
  } else {
    bytes = raw;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readCommonHeader(view, bytes);
  const { version, numPoints, shDegree, fractionalBits } = header;

  if (!Number.isFinite(numPoints) || numPoints <= 0) {
    throw new Error(`SPZ: invalid splat count (${numPoints})`);
  }
  if (shDimForDegree(shDegree) < 0) throw new Error(`SPZ: invalid SH degree ${shDegree}`);
  if (fractionalBits === 0 || fractionalBits > 24) {
    throw new Error(`SPZ: invalid fractionalBits ${fractionalBits}`);
  }
  if (version === 1) {
    // v1 stored positions as float16 rather than 24-bit fixed point.
    throw new Error('SPZ: version 1 files are not supported — re-export with a current SPZ writer.');
  }
  if (version < 1 || version > 4) {
    throw new Error(`SPZ: unsupported version ${version}`);
  }

  // v2 packs the first three quaternion components, v3 and later the smallest three.
  const smallestThree = version >= 3;
  const rotationBytes = smallestThree ? 4 : 3;

  let payload;
  if (version >= 4) {
    payload = readV4Payload(bytes, view, header, bytes[15]);
  } else {
    payload = bytes.subarray(16);
  }

  const { positions, alphas, colors, scales, rotations } =
    sliceSections(payload, numPoints, rotationBytes);

  const posScale = 1 / (1 << fractionalBits);

  // Byte -> linear scale and byte -> colour channel are both 256-entry mappings;
  // precompute rather than calling exp() per component.
  const scaleLUT = new Float32Array(256);
  for (let b = 0; b < 256; b++) scaleLUT[b] = Math.exp(b / 16 - 10);

  const colorLUT = new Uint8Array(256);
  for (let b = 0; b < 256; b++) {
    const dc = (b / 255 - 0.5) / COLOR_SCALE;
    let v = 0.5 + SH_C0 * dc;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    colorLUT[b] = Math.round(v * 255);
  }

  const out = new Uint8Array(numPoints * 32);
  const outView = new DataView(out.buffer);

  const q = [0, 0, 0, 0]; // x, y, z, w
  let hasVisibleAlpha = false;

  for (let i = 0; i < numPoints; i++) {
    const base = i * 32;
    const p3 = i * 3;

    // ── Position: three little-endian signed 24-bit fixed-point values ──
    let o = i * 9;
    for (let k = 0; k < 3; k++) {
      let fixed = positions[o] | (positions[o + 1] << 8) | (positions[o + 2] << 16);
      if (fixed & 0x800000) fixed |= ~0xffffff; // sign extend to 32 bits
      outView.setFloat32(base + k * 4, fixed * posScale, true);
      o += 3;
    }

    // ── Scale (log space byte -> linear) ────────────────────────────────
    outView.setFloat32(base + 12, scaleLUT[scales[p3]], true);
    outView.setFloat32(base + 16, scaleLUT[scales[p3 + 1]], true);
    outView.setFloat32(base + 20, scaleLUT[scales[p3 + 2]], true);

    // ── Colour + opacity ────────────────────────────────────────────────
    out[base + 24] = colorLUT[colors[p3]];
    out[base + 25] = colorLUT[colors[p3 + 1]];
    out[base + 26] = colorLUT[colors[p3 + 2]];
    const a = alphas[i];
    out[base + 27] = a;
    if (a > 0) hasVisibleAlpha = true;

    // ── Rotation ────────────────────────────────────────────────────────
    if (smallestThree) {
      const r = i * 4;
      let comp = (rotations[r] | (rotations[r + 1] << 8) | (rotations[r + 2] << 16) |
                  (rotations[r + 3] << 24)) >>> 0;
      const iLargest = comp >>> 30;
      let sumSquares = 0;
      for (let k = 3; k >= 0; k--) {
        if (k === iLargest) continue;
        const mag = comp & SMALLEST_THREE_MASK;
        const negative = (comp >>> 9) & 1;
        comp >>>= 10;
        let v = SQRT1_2 * mag / SMALLEST_THREE_MASK;
        if (negative) v = -v;
        q[k] = v;
        sumSquares += v * v;
      }
      q[iLargest] = Math.sqrt(Math.max(0, 1 - sumSquares));
    } else {
      const r = p3;
      q[0] = rotations[r] / 127.5 - 1;
      q[1] = rotations[r + 1] / 127.5 - 1;
      q[2] = rotations[r + 2] / 127.5 - 1;
      q[3] = Math.sqrt(Math.max(0, 1 - (q[0] * q[0] + q[1] * q[1] + q[2] * q[2])));
    }

    // Output order matches encodeUncompressedSplatArray: w, x, y, z
    out[base + 28] = quaternionByte(q[3]);
    out[base + 29] = quaternionByte(q[0]);
    out[base + 30] = quaternionByte(q[1]);
    out[base + 31] = quaternionByte(q[2]);
  }

  // A file whose alphas are all zero would render as nothing at all; treat it
  // the same way the .ply and .ksplat paths do and force full opacity.
  if (!hasVisibleAlpha) {
    for (let i = 0; i < numPoints; i++) out[i * 32 + 27] = 255;
  }

  return out;
}
