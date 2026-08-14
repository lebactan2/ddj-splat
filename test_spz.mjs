// Round-trip test for src/spzLoader.js: encode synthetic SPZ v2 / v3 / v4
// files per the Niantic spec, decode them, compare against the source values.
import { gzipSync } from 'fflate';
import { decodeSpz } from './src/spzLoader.js';

const SH_C0 = 0.28209479177387814;
const COLOR_SCALE = 0.15;
const FRACTIONAL_BITS = 12;

// ── Source gaussians ────────────────────────────────────────────────────────
const gaussians = [
  { pos: [0, 0, 0],           scale: [0.01, 0.02, 0.03], rgb: [1, 1, 1],     alpha: 1.0,  quat: [0, 0, 0, 1] },
  { pos: [1.5, -2.25, 3.125], scale: [0.1, 0.1, 0.1],    rgb: [0.5, 0.5, 0.5], alpha: 0.5,  quat: [0.7071067811865476, 0, 0, 0.7071067811865476] },
  { pos: [-10.5, 7.75, 0.5],  scale: [1.0, 0.5, 0.25],   rgb: [1, 0, 0],     alpha: 0.25, quat: [0, 0.5, 0.5, 0.7071067811865476] },
  { pos: [0.125, 0.25, -0.5], scale: [0.005, 0.05, 0.5], rgb: [0, 0.25, 0.75], alpha: 1.0, quat: [-0.5, -0.5, -0.5, 0.5] },
];
const N = gaussians.length;

// ── Packing helpers (mirror of Niantic's writer) ────────────────────────────
const toUint8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

function packPositions() {
  const out = new Uint8Array(N * 9);
  let o = 0;
  for (const g of gaussians) {
    for (const p of g.pos) {
      const fixed = Math.round(p * (1 << FRACTIONAL_BITS));
      out[o++] = fixed & 0xff;
      out[o++] = (fixed >> 8) & 0xff;
      out[o++] = (fixed >> 16) & 0xff;
    }
  }
  return out;
}

function packAlphas() {
  // Writer stores sigmoid(alphaLogit)*255; our source alpha is already 0..1.
  return new Uint8Array(gaussians.map((g) => toUint8(g.alpha * 255)));
}

function packColors() {
  const out = new Uint8Array(N * 3);
  let o = 0;
  for (const g of gaussians) {
    for (const c of g.rgb) {
      const dc = (c - 0.5) / SH_C0;                       // rgb -> SH DC coefficient
      out[o++] = toUint8(dc * (COLOR_SCALE * 255) + 0.5 * 255);
    }
  }
  return out;
}

function packScales() {
  const out = new Uint8Array(N * 3);
  let o = 0;
  for (const g of gaussians) {
    for (const s of g.scale) out[o++] = toUint8((Math.log(s) + 10) * 16);
  }
  return out;
}

function packRotationsFirstThree() {
  const out = new Uint8Array(N * 3);
  let o = 0;
  for (const g of gaussians) {
    const [x, y, z, w] = g.quat;
    // Writer canonicalises to w >= 0 before dropping it.
    const s = w < 0 ? -1 : 1;
    for (const v of [x * s, y * s, z * s]) out[o++] = toUint8((v + 1) * 127.5);
  }
  return out;
}

function packRotationsSmallestThree() {
  const out = new Uint8Array(N * 4);
  const MASK = (1 << 9) - 1;
  for (let i = 0; i < N; i++) {
    const q = gaussians[i].quat.slice(); // x,y,z,w
    let iLargest = 0;
    for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[iLargest])) iLargest = k;
    if (q[iLargest] < 0) for (let k = 0; k < 4; k++) q[k] = -q[k];

    // The reader consumes k = 3,2,1,0 starting at the low bits, so k=3 (w)
    // occupies the lowest field unless it is the omitted largest component.
    let comp = 0;
    let shift = 0;
    for (let k = 3; k >= 0; k--) {
      if (k === iLargest) continue;
      const v = q[k];
      const mag = Math.round((Math.abs(v) / Math.SQRT1_2) * MASK);
      const field = (mag & MASK) | (v < 0 ? (1 << 9) : 0);
      comp |= field << shift;
      shift += 10;
    }
    comp = (comp >>> 0) | (iLargest << 30);
    comp >>>= 0;
    out[i * 4] = comp & 0xff;
    out[i * 4 + 1] = (comp >>> 8) & 0xff;
    out[i * 4 + 2] = (comp >>> 16) & 0xff;
    out[i * 4 + 3] = (comp >>> 24) & 0xff;
  }
  return out;
}

function concat(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

function legacyHeader(version) {
  const h = new Uint8Array(16);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x5053474e, true);
  v.setUint32(4, version, true);
  v.setUint32(8, N, true);
  h[12] = 0;                // shDegree
  h[13] = FRACTIONAL_BITS;
  h[14] = 0;                // flags
  h[15] = 0;                // reserved
  return h;
}

function buildLegacy(version) {
  const rot = version >= 3 ? packRotationsSmallestThree() : packRotationsFirstThree();
  const payload = concat([packPositions(), packAlphas(), packColors(), packScales(), rot]);
  return gzipSync(concat([legacyHeader(version), payload]));
}

// ── Minimal ZSTD frame containing a single raw (uncompressed) block ──────────
function zstdRawFrame(data) {
  const blockHeader = (data.length << 3) | (0 << 1) | 1; // size, type=raw, last=1
  const out = new Uint8Array(4 + 1 + 4 + 3 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0xfd2fb528, true);   // magic
  out[4] = 0xa0;                      // single segment + 4-byte frame content size
  v.setUint32(5, data.length, true);
  out[9] = blockHeader & 0xff;
  out[10] = (blockHeader >> 8) & 0xff;
  out[11] = (blockHeader >> 16) & 0xff;
  out.set(data, 12);
  return out;
}

function buildV4() {
  const streams = [
    packPositions(), packAlphas(), packColors(), packScales(), packRotationsSmallestThree(),
  ].map((raw) => ({ raw, frame: zstdRawFrame(raw) }));

  const header = new Uint8Array(32);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 0x5053474e, true);
  hv.setUint32(4, 4, true);
  hv.setUint32(8, N, true);
  header[12] = 0;                 // shDegree
  header[13] = FRACTIONAL_BITS;
  header[14] = 0;                 // flags
  header[15] = streams.length;    // numStreams
  hv.setUint32(16, 32, true);     // tocByteOffset (no extension records)

  const toc = new Uint8Array(streams.length * 16);
  const tv = new DataView(toc.buffer);
  streams.forEach((s, i) => {
    tv.setUint32(i * 16, s.frame.length, true);
    tv.setUint32(i * 16 + 4, 0, true);
    tv.setUint32(i * 16 + 8, s.raw.length, true);
    tv.setUint32(i * 16 + 12, 0, true);
  });

  return concat([header, toc, ...streams.map((s) => s.frame)]);
}

// ── Checks ──────────────────────────────────────────────────────────────────
let failures = 0;
function check(label, got, want, tol) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) { failures++; console.log(`  FAIL ${label}: got ${got}, want ${want} (tol ${tol})`); }
  return ok;
}

function verify(name, buffer) {
  console.log(`\n=== ${name} ===`);
  const out = decodeSpz(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const view = new DataView(out.buffer);
  if (out.length !== N * 32) { failures++; console.log(`  FAIL length ${out.length} != ${N * 32}`); return; }

  for (let i = 0; i < N; i++) {
    const g = gaussians[i];
    const b = i * 32;
    const posTol = 1 / (1 << FRACTIONAL_BITS);
    check(`p${i}.x`, view.getFloat32(b, true), g.pos[0], posTol);
    check(`p${i}.y`, view.getFloat32(b + 4, true), g.pos[1], posTol);
    check(`p${i}.z`, view.getFloat32(b + 8, true), g.pos[2], posTol);

    for (let k = 0; k < 3; k++) {
      const got = view.getFloat32(b + 12 + k * 4, true);
      check(`s${i}[${k}]`, got, g.scale[k], g.scale[k] * 0.04); // 1/16 log step ≈ 3.2%
    }

    for (let k = 0; k < 3; k++) {
      check(`c${i}[${k}]`, out[b + 24 + k], Math.round(g.rgb[k] * 255), 4);
    }
    check(`a${i}`, out[b + 27], Math.round(g.alpha * 255), 1);

    // Quaternion sign is arbitrary (q and -q are the same rotation).
    const dq = [out[b + 29], out[b + 30], out[b + 31], out[b + 28]].map((v) => v / 127.5 - 1);
    const src = g.quat;
    const dot = dq[0] * src[0] + dq[1] * src[1] + dq[2] * src[2] + dq[3] * src[3];
    const sign = dot < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) check(`q${i}[${k}]`, dq[k] * sign, src[k], 0.02);
  }
  console.log(`  ${N} splats decoded`);
}

verify('v2 (legacy gzip, first-three quats)', buildLegacy(2));
verify('v3 (legacy gzip, smallest-three quats)', buildLegacy(3));
verify('v4 (ZSTD streams + TOC)', buildV4());

// Error paths
for (const [label, bad] of [
  ['v1 rejected', gzipSync(concat([legacyHeader(1), new Uint8Array(N * 20)]))],
  ['bad magic', gzipSync(new Uint8Array(64))],
  ['truncated', gzipSync(concat([legacyHeader(2), new Uint8Array(10)]))],
]) {
  try {
    decodeSpz(bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength));
    failures++;
    console.log(`\nFAIL ${label}: expected a throw`);
  } catch (e) {
    console.log(`\nOK ${label}: ${e.message}`);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
