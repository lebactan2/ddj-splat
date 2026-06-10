import { SplatData } from '../dataModel.js';

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function getAmount(opts, fallback = 1) {
  return clamp01(opts?.amount ?? fallback);
}

function getPosition(view, index) {
  const base = index * 32;
  return [
    view.getFloat32(base + 0, true),
    view.getFloat32(base + 4, true),
    view.getFloat32(base + 8, true),
  ];
}

function setPosition(view, index, x, y, z) {
  const base = index * 32;
  view.setFloat32(base + 0, x, true);
  view.setFloat32(base + 4, y, true);
  view.setFloat32(base + 8, z, true);
}

function scaleSplatSize(view, index, scaleFactor) {
  const base = index * 32;
  view.setFloat32(base + 12, view.getFloat32(base + 12, true) * scaleFactor, true);
  view.setFloat32(base + 16, view.getFloat32(base + 16, true) * scaleFactor, true);
  view.setFloat32(base + 20, view.getFloat32(base + 20, true) * scaleFactor, true);
}

function fadeSplat(data, index, alphaFactor, colorFactor = 1) {
  const base = index * 32;
  data[base + 24] = clampByte(data[base + 24] * colorFactor);
  data[base + 25] = clampByte(data[base + 25] * colorFactor);
  data[base + 26] = clampByte(data[base + 26] * colorFactor);
  data[base + 27] = clampByte(data[base + 27] * alphaFactor);
}

function estimateCenter(splatData) {
  const count = splatData.splatCount;
  if (!count) return [0, 0, 0];

  let x = 0;
  let y = 0;
  let z = 0;
  const view = new DataView(splatData.data.buffer, splatData.data.byteOffset, splatData.data.byteLength);
  for (let i = 0; i < count; i++) {
    const base = i * 32;
    x += view.getFloat32(base, true);
    y += view.getFloat32(base + 4, true);
    z += view.getFloat32(base + 8, true);
  }

  return [x / count, y / count, z / count];
}

function estimateBounds(splatData) {
  const count = splatData.splatCount;
  if (!count) {
    return {
      min: [0, 0, 0],
      max: [0, 0, 0],
      center: [0, 0, 0],
      size: [1, 1, 1],
    };
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const view = new DataView(splatData.data.buffer, splatData.data.byteOffset, splatData.data.byteLength);

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = view.getFloat32(base, true);
    const py = view.getFloat32(base + 4, true);
    const pz = view.getFloat32(base + 8, true);

    if (px < min[0]) min[0] = px;
    if (px > max[0]) max[0] = px;
    if (py < min[1]) min[1] = py;
    if (py > max[1]) max[1] = py;
    if (pz < min[2]) min[2] = pz;
    if (pz > max[2]) max[2] = pz;
  }

  const center = [
    (min[0] + max[0]) * 0.5,
    (min[1] + max[1]) * 0.5,
    (min[2] + max[2]) * 0.5,
  ];
  const size = [
    Math.max(max[0] - min[0], 0.001),
    Math.max(max[1] - min[1], 0.001),
    Math.max(max[2] - min[2], 0.001),
  ];

  return { min, max, center, size };
}

function normalizeDistance(position, center, size) {
  const dx = (position[0] - center[0]) / size[0];
  const dy = (position[1] - center[1]) / size[1];
  const dz = (position[2] - center[2]) / size[2];
  return Math.min(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function isInsideBox(position, center, halfSize) {
  return Math.abs(position[0] - center[0]) <= halfSize[0] &&
         Math.abs(position[1] - center[1]) <= halfSize[1] &&
         Math.abs(position[2] - center[2]) <= halfSize[2];
}

function getSampledIndexes(count, ghostRatio) {
  const ghostCount = Math.max(1, Math.floor(count * ghostRatio));
  const step = Math.max(1, Math.floor(count / ghostCount));
  const indexes = [];

  for (let i = 0; i < count; i += step) {
    indexes.push(i);
  }

  return indexes;
}

function copySampledGhosts(source, output, writeIndex, sampledIndexes, opts, mutateGhost) {
  const count = source.splatCount;

  for (let tap = 1; tap <= opts.taps; tap++) {
    for (const i of sampledIndexes) {
      if (i >= count) continue;
      const srcBase = i * 32;
      const dstBase = writeIndex * 32;
      output.copyWithin(dstBase, srcBase, srcBase + 32);
      mutateGhost(output, writeIndex, i, tap);
      writeIndex++;
    }
  }

  return writeIndex;
}

export function applyDelayFx(source, params = {}) {
  // Utilizing 2D feedback AfterimagePass instead of CPU geometry duplication
  return source;
}

export function applyEchoFx(source, params = {}) {
  // Utilizing 2D feedback AfterimagePass instead of CPU geometry duplication
  return source;
}

export function applyPitchFx(source, params = {}) {
  const count = source.splatCount;
  const output = new Uint8Array(source.data);
  const pitchShift = 0.15 + getAmount(params) * 0.85;

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const r = output[base + 24] / 255;
    const g = output[base + 25] / 255;
    const b = output[base + 26] / 255;
    const energy = Math.max(r, g, b);
    const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;

    const red = r * (1 + pitchShift * 0.85) + g * pitchShift * 0.18 + luminance * 0.12;
    const green = g * (1 - pitchShift * 0.18) + luminance * 0.16;
    const blue = b * (1 - pitchShift * 0.72) + (1 - energy) * pitchShift * 0.1;

    output[base + 24] = clampByte(red * 255);
    output[base + 25] = clampByte(green * 255);
    output[base + 26] = clampByte(blue * 255);
  }

  return new SplatData(output);
}

export function applyRollFx(source, params = {}) {
  const count = source.splatCount;
  const amount = getAmount(params);
  const bounds = estimateBounds(source);
  const boxHalfSize = [
    bounds.size[0] * (0.12 + amount * 0.18),
    bounds.size[1] * (0.14 + amount * 0.22),
    bounds.size[2] * (0.12 + amount * 0.18),
  ];
  const capturedIndexes = [];

  const srcView = new DataView(source.data.buffer, source.data.byteOffset, source.data.byteLength);

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = srcView.getFloat32(base, true);
    const py = srcView.getFloat32(base + 4, true);
    const pz = srcView.getFloat32(base + 8, true);

    if (Math.abs(px - bounds.center[0]) <= boxHalfSize[0] &&
        Math.abs(py - bounds.center[1]) <= boxHalfSize[1] &&
        Math.abs(pz - bounds.center[2]) <= boxHalfSize[2]) {
      capturedIndexes.push(i);
    }
  }

  if (capturedIndexes.length === 0 && count > 0) {
    capturedIndexes.push(Math.floor(count * 0.5));
  }

  const taps = 2 + Math.round(amount * 5);
  const output = new Uint8Array((count + capturedIndexes.length * taps) * 32);
  output.set(source.data, 0);

  const dstView = new DataView(output.buffer, output.byteOffset, output.byteLength);

  const captured = new Set(capturedIndexes);
  for (let i = 0; i < count; i++) {
    if (captured.has(i)) {
      fadeSplat(output, i, 1, 1.12);
      scaleSplatSize(dstView, i, 1.08);
    } else {
      fadeSplat(output, i, 0.62, 0.72);
    }
  }

  let writeIndex = count;
  for (let tap = 1; tap <= taps; tap++) {
    const phase = tap / taps;
    for (const srcIndex of capturedIndexes) {
      const srcBase = srcIndex * 32;
      const dstBase = writeIndex * 32;
      output.copyWithin(dstBase, srcBase, srcBase + 32);

      const px = srcView.getFloat32(srcBase, true);
      const py = srcView.getFloat32(srcBase + 4, true);
      const pz = srcView.getFloat32(srcBase + 8, true);

      const jitter = Math.sin(srcIndex * 12.9898 + tap * 78.233);
      const stutter = Math.cos(srcIndex * 4.1414 + tap * 31.77);

      setPosition(
        dstView,
        writeIndex,
        px + jitter * bounds.size[0] * 0.018 * amount * phase,
        py + stutter * bounds.size[1] * 0.015 * amount * phase,
        pz + (jitter - stutter) * bounds.size[2] * 0.012 * amount * phase
      );

      fadeSplat(output, writeIndex, 0.72 - phase * 0.38, 0.95 + phase * 0.2);
      scaleSplatSize(dstView, writeIndex, 1 + phase * 0.22);
      writeIndex++;
    }
  }

  return new SplatData(output.subarray(0, writeIndex * 32));
}

export function applyReverbFx(source, params = {}) {
  const amount = getAmount(params);
  const opts = {
    taps: 2 + Math.round(amount * 4),
    ghostRatio: 0.08 + amount * 0.24,
    spread: 0.025 + amount * 0.08,
    feedback: 0.25 + amount * 0.42,
  };
  const count = source.splatCount;
  const bounds = estimateBounds(source);
  const sampledIndexes = getSampledIndexes(count, opts.ghostRatio);
  const output = new Uint8Array((count + sampledIndexes.length * opts.taps) * 32);
  output.set(source.data, 0);

  const srcView = new DataView(source.data.buffer, source.data.byteOffset, source.data.byteLength);
  const dstView = new DataView(output.buffer, output.byteOffset, output.byteLength);

  for (let i = 0; i < count; i++) {
    fadeSplat(output, i, 0.82, 0.86);
  }

  let writeIndex = count;
  writeIndex = copySampledGhosts(source, output, writeIndex, sampledIndexes, opts, (data, index, srcIndex, tap) => {
    const [x, y, z] = getPosition(srcView, srcIndex);
    const phase = srcIndex * 19.19 + tap * 7.77;
    const decay = Math.pow(opts.feedback, tap);
    setPosition(
      dstView,
      index,
      x + Math.sin(phase) * bounds.size[0] * opts.spread * tap,
      y + Math.cos(phase * 0.71) * bounds.size[1] * opts.spread * tap,
      z + Math.sin(phase * 1.37) * bounds.size[2] * opts.spread * tap
    );
    fadeSplat(data, index, decay, 0.72);
    scaleSplatSize(dstView, index, 1 + tap * 0.35);
  });

  return new SplatData(output.subarray(0, writeIndex * 32));
}

export function applySpiralFx(source, params = {}) {
  const count = source.splatCount;
  const amount = getAmount(params);
  const bounds = estimateBounds(source);
  const center = bounds.center;
  const taps = 2 + Math.round(amount * 5);
  const sampledIndexes = getSampledIndexes(count, 0.12 + amount * 0.34);
  const output = new Uint8Array((count + sampledIndexes.length * taps) * 32);
  output.set(source.data, 0);

  const srcView = new DataView(source.data.buffer, source.data.byteOffset, source.data.byteLength);
  const dstView = new DataView(output.buffer, output.byteOffset, output.byteLength);

  for (let i = 0; i < count; i++) {
    fadeSplat(output, i, 0.76, 0.82);
  }

  let writeIndex = count;
  for (let tap = 1; tap <= taps; tap++) {
    const t = tap / taps;
    const angle = tap * (0.35 + amount * 0.82);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const collapse = Math.pow(0.88 - amount * 0.28, tap);
    const covarianceScale = Math.pow(0.86 - amount * 0.38, tap);

    for (const srcIndex of sampledIndexes) {
      const srcBase = srcIndex * 32;
      const dstBase = writeIndex * 32;
      output.copyWithin(dstBase, srcBase, srcBase + 32);

      const px = srcView.getFloat32(srcBase, true);
      const py = srcView.getFloat32(srcBase + 4, true);
      const pz = srcView.getFloat32(srcBase + 8, true);

      const dx = px - center[0];
      const dy = py - center[1];
      const dz = pz - center[2];
      const sx = dx * cos - dz * sin;
      const sz = dx * sin + dz * cos;

      setPosition(
        dstView,
        writeIndex,
        center[0] + sx * collapse,
        center[1] + dy * collapse + bounds.size[1] * 0.018 * tap,
        center[2] + sz * collapse
      );
      scaleSplatSize(dstView, writeIndex, covarianceScale);

      const r = output[dstBase + 24] / 255;
      const g = output[dstBase + 25] / 255;
      const b = output[dstBase + 26] / 255;
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
      output[dstBase + 24] = clampByte((r * (1 + t * 1.2) + luminance * t * 0.4) * 255);
      output[dstBase + 25] = clampByte((g * (1 - t * 0.35) + b * t * 0.25) * 255);
      output[dstBase + 26] = clampByte((b * (1 - t * 0.75) + (1 - luminance) * t * 0.3) * 255);
      output[dstBase + 27] = clampByte(output[dstBase + 27] * Math.pow(0.74, tap));

      writeIndex++;
    }
  }

  return new SplatData(output.subarray(0, writeIndex * 32));
}

export function applyFilterFx(source, params = {}) {
  const count = source.splatCount;
  const output = new Uint8Array(source.data);
  const bounds = estimateBounds(source);
  const amount = getAmount(params);
  const low = clamp01(params?.low ?? 0.65);
  const mid = clamp01(params?.mid ?? 0.5);
  const high = clamp01(params?.high ?? 0.35);

  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = view.getFloat32(base, true);
    const py = view.getFloat32(base + 4, true);
    const pz = view.getFloat32(base + 8, true);

    const radius = normalizeDistance([px, py, pz], bounds.center, bounds.size);
    const shellCount = 18;
    const shell = radius * shellCount;
    const shellIndex = Math.min(shellCount - 1, Math.floor(shell));
    const shellLocal = shell - shellIndex;
    const region = Math.min(2, Math.floor(radius * 3));
    const lowBand = region === 0 ? 1 : 0;
    const midBand = region === 1 ? 1 : 0;
    const highBand = region === 2 ? 1 : 0;
    const bandLevel = low * lowBand + mid * midBand + high * highBand;
    const dx = px - bounds.center[0];
    const dy = py - bounds.center[1];
    const dz = pz - bounds.center[2];
    const invLength = 1 / Math.max(0.0001, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const nx = dx * invLength;
    const ny = dy * invLength;
    const nz = dz * invLength;
    const grain = Math.sin((shellIndex + 1) * 16.193 + amount * 5.7);
    const shellPulse = 0.55 + Math.abs(shellLocal - 0.5) * 0.9;
    const cutAmount = amount * bandLevel * shellPulse;
    const shellGap = Math.max(bounds.size[0], bounds.size[1], bounds.size[2]) * 0.16 * cutAmount;
    const tangentJitter = Math.cos(shellIndex * 2.31) * 0.035 * cutAmount;

    view.setFloat32(base, px + nx * shellGap * (0.85 + grain * 0.22) + nz * bounds.size[0] * tangentJitter, true);
    view.setFloat32(base + 4, py + ny * shellGap * (0.85 + grain * 0.22), true);
    view.setFloat32(base + 8, pz + nz * shellGap * (0.85 + grain * 0.22) - nx * bounds.size[2] * tangentJitter, true);

    const scaleFactor = bandLevel * Math.max(0, 1 - cutAmount * 0.68 + lowBand * low * amount * 0.14);
    view.setFloat32(base + 12, view.getFloat32(base + 12, true) * scaleFactor, true);
    view.setFloat32(base + 16, view.getFloat32(base + 16, true) * scaleFactor, true);
    view.setFloat32(base + 20, view.getFloat32(base + 20, true) * scaleFactor, true);

    output[base + 27] = clampByte(output[base + 27] * bandLevel);
  }

  return new SplatData(output);
}

export function applyFlangerFx(source, params = {}) {
  const count = source.splatCount;
  const amount = getAmount(params);
  const output = new Uint8Array(count * 2 * 32);
  const bounds = estimateBounds(source);
  output.set(source.data, 0);

  const srcView = new DataView(source.data.buffer, source.data.byteOffset, source.data.byteLength);
  const dstView = new DataView(output.buffer, output.byteOffset, output.byteLength);

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = srcView.getFloat32(base, true);
    const py = srcView.getFloat32(base + 4, true);
    const pz = srcView.getFloat32(base + 8, true);

    const phase = Math.sin((px - bounds.center[0]) * (9 + amount * 18) + (pz - bounds.center[2]) * (6 + amount * 12));
    output[base + 24] = clampByte(output[base + 24] * (0.92 + phase * 0.22 * amount));
    output[base + 25] = clampByte(output[base + 25] * (0.94 - phase * 0.17 * amount));
    output[base + 26] = clampByte(output[base + 26] * (1.02 + phase * 0.2 * amount));

    const dstIndex = count + i;
    const dstBase = dstIndex * 32;
    output.copyWithin(dstBase, base, base + 32);

    dstView.setFloat32(dstBase, px + phase * bounds.size[0] * 0.03 * amount, true);
    dstView.setFloat32(dstBase + 4, py, true);
    dstView.setFloat32(dstBase + 8, pz - phase * bounds.size[2] * 0.03 * amount, true);

    const alphaFactor = 0.18 + amount * 0.34 + Math.abs(phase) * 0.16;
    const colorFactor = 0.65 + amount * 0.18;
    output[dstBase + 24] = clampByte(output[dstBase + 24] * colorFactor);
    output[dstBase + 25] = clampByte(output[dstBase + 25] * colorFactor);
    output[dstBase + 26] = clampByte(output[dstBase + 26] * colorFactor);
    output[dstBase + 27] = clampByte(output[dstBase + 27] * alphaFactor);

    const scaleFactor = 1 + amount * 0.12;
    dstView.setFloat32(dstBase + 12, dstView.getFloat32(dstBase + 12, true) * scaleFactor, true);
    dstView.setFloat32(dstBase + 16, dstView.getFloat32(dstBase + 16, true) * scaleFactor, true);
    dstView.setFloat32(dstBase + 20, dstView.getFloat32(dstBase + 20, true) * scaleFactor, true);
  }

  return new SplatData(output);
}

export function applyPhaserFx(source, params = {}) {
  const count = source.splatCount;
  const output = new Uint8Array(source.data);
  const bounds = estimateBounds(source);
  const amount = getAmount(params);

  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = view.getFloat32(base, true);
    const py = view.getFloat32(base + 4, true);
    const pz = view.getFloat32(base + 8, true);

    const phaseA = Math.sin((px - bounds.center[0]) * (5 + amount * 12) + (py - bounds.center[1]) * (7 + amount * 16));
    const phaseB = Math.cos((pz - bounds.center[2]) * (8 + amount * 14) - (px - bounds.center[0]) * (4 + amount * 9));
    const notch = 0.5 + 0.5 * phaseA * phaseB;

    const scaleFactor = 1.0 - amount * 0.4 + notch * amount * 0.4;
    view.setFloat32(base + 12, view.getFloat32(base + 12, true) * scaleFactor, true);
    view.setFloat32(base + 16, view.getFloat32(base + 16, true) * scaleFactor, true);
    view.setFloat32(base + 20, view.getFloat32(base + 20, true) * scaleFactor, true);
  }

  return new SplatData(output);
}
