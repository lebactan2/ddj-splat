/**
 * shuffle.js
 * Rearranges chunks within a single scene by swapping their positions.
 */

export function shuffleChunksInScene(splatData, chunkIds, numChunks, rng) {
  // 1. Calculate centroid for each chunk
  const centroids = [];
  const chunkCounts = [];
  for (let i = 0; i < numChunks; i++) {
    centroids.push([0, 0, 0]);
    chunkCounts.push(0);
  }

  const count = splatData.splatCount;
  for (let i = 0; i < count; i++) {
    const cid = chunkIds[i];
    if (cid < 0 || cid >= numChunks) continue;
    const [x, y, z] = splatData.getPosition(i);
    centroids[cid][0] += x;
    centroids[cid][1] += y;
    centroids[cid][2] += z;
    chunkCounts[cid]++;
  }

  for (let i = 0; i < numChunks; i++) {
    if (chunkCounts[i] > 0) {
      centroids[i][0] /= chunkCounts[i];
      centroids[i][1] /= chunkCounts[i];
      centroids[i][2] /= chunkCounts[i];
    }
  }

  // 2. Identify non-empty chunks to shuffle
  const activeChunks = [];
  for (let i = 0; i < numChunks; i++) {
    if (chunkCounts[i] > 0) activeChunks.push(i);
  }

  // Use the seeded RNG to generate the permutation
  const perm = [...activeChunks];
  rng.shuffle(perm);

  // Map original chunk id to target chunk id
  const targetMap = new Map();
  for (let i = 0; i < activeChunks.length; i++) {
    targetMap.set(activeChunks[i], perm[i]);
  }

  // 3. For each active chunk, calculate the translation vector to its new slot
  const translations = new Map();
  for (let i = 0; i < activeChunks.length; i++) {
    const cid = activeChunks[i];
    const targetId = targetMap.get(cid);

    translations.set(cid, [
      centroids[targetId][0] - centroids[cid][0],
      centroids[targetId][1] - centroids[cid][1],
      centroids[targetId][2] - centroids[cid][2],
    ]);
  }

  // 4. Apply translations
  for (let i = 0; i < count; i++) {
    const cid = chunkIds[i];
    if (!translations.has(cid)) continue;

    const [x, y, z] = splatData.getPosition(i);
    const t = translations.get(cid);

    splatData.setPosition(i, x + t[0], y + t[1], z + t[2]);
  }
}
