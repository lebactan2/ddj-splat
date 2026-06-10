/**
 * transform.js
 * Applies random transforms to chunks after the cut-up:
 *   move, rotate, scale, color jitter, random drop.
 */

export function applyTransforms(splatData, chunkIds, numChunks, opts, rng) {
  const count = splatData.splatCount;

  // Pre-compute per-chunk transforms
  const chunkMove = [];
  const chunkScaleFactor = [];
  const chunkColorShift = [];
  const chunkDropped = [];
  const chunkAngle = []; // rotation around Y axis (simplistic)

  for (let c = 0; c < numChunks; c++) {
    chunkMove.push(opts.move ? [rng.nextFloat(-0.5, 0.5), rng.nextFloat(-0.5, 0.5), rng.nextFloat(-0.5, 0.5)] : [0, 0, 0]);
    chunkScaleFactor.push(opts.scale ? rng.nextFloat(0.5, 1.5) : 1.0);
    chunkColorShift.push(opts.colorJitter ? [rng.nextInt(-40, 40), rng.nextInt(-40, 40), rng.nextInt(-40, 40)] : [0, 0, 0]);
    chunkDropped.push(opts.randomDrop ? rng.next() < 0.2 : false); // 20% chance to drop a chunk
    chunkAngle.push(opts.rotate ? rng.nextFloat(-Math.PI, Math.PI) : 0);
  }

  // Calculate centroids for rotation
  const centroids = new Array(numChunks).fill(null).map(() => [0, 0, 0]);
  const chunkCounts = new Array(numChunks).fill(0);
  for (let i = 0; i < count; i++) {
    const cid = chunkIds[i];
    if (cid < 0 || cid >= numChunks) continue;
    const [x, y, z] = splatData.getPosition(i);
    centroids[cid][0] += x;
    centroids[cid][1] += y;
    centroids[cid][2] += z;
    chunkCounts[cid]++;
  }
  for (let c = 0; c < numChunks; c++) {
    if (chunkCounts[c] > 0) {
      centroids[c][0] /= chunkCounts[c];
      centroids[c][1] /= chunkCounts[c];
      centroids[c][2] /= chunkCounts[c];
    }
  }

  // Apply transforms per-splat
  // We iterate backwards so we can "drop" splats by zeroing their opacity
  for (let i = 0; i < count; i++) {
    const cid = chunkIds[i];
    if (cid < 0 || cid >= numChunks) continue;

    // Drop
    if (chunkDropped[cid]) {
      // Set opacity to 0 (byte 27 in the 32-byte block)
      splatData.data[i * 32 + 27] = 0;
      continue;
    }

    let [x, y, z] = splatData.getPosition(i);

    // Rotate around centroid (Y-axis)
    if (opts.rotate) {
      const angle = chunkAngle[cid];
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const cx = centroids[cid][0];
      const cz = centroids[cid][2];
      const dx = x - cx;
      const dz = z - cz;
      x = cx + dx * cos - dz * sin;
      z = cz + dx * sin + dz * cos;
    }

    // Scale around centroid
    if (opts.scale) {
      const s = chunkScaleFactor[cid];
      x = centroids[cid][0] + (x - centroids[cid][0]) * s;
      y = centroids[cid][1] + (y - centroids[cid][1]) * s;
      z = centroids[cid][2] + (z - centroids[cid][2]) * s;
    }

    // Move
    if (opts.move) {
      x += chunkMove[cid][0];
      y += chunkMove[cid][1];
      z += chunkMove[cid][2];
    }

    splatData.setPosition(i, x, y, z);

    // Color jitter
    if (opts.colorJitter) {
      const base = i * 32 + 24;
      const shift = chunkColorShift[cid];
      splatData.data[base + 0] = Math.max(0, Math.min(255, splatData.data[base + 0] + shift[0]));
      splatData.data[base + 1] = Math.max(0, Math.min(255, splatData.data[base + 1] + shift[1]));
      splatData.data[base + 2] = Math.max(0, Math.min(255, splatData.data[base + 2] + shift[2]));
    }
  }
}
