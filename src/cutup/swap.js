/**
 * swap.js
 * Takes two scenes sliced into chunks and swaps a fraction of their chunks,
 * then merges them into a single new scene.
 */

import { SplatData } from '../dataModel.js';

export function swapChunksBetweenScenes(splatDataA, splatDataB, chunkIdsA, chunkIdsB, numChunks, mixAmount, rng) {
  // Determine which chunks to swap based on mixAmount
  const swapFlags = new Array(numChunks);
  for (let i = 0; i < numChunks; i++) {
    swapFlags[i] = rng.next() < mixAmount;
  }

  // Collect splats that belong to the final merged scene:
  //   - For non-swapped chunks: take from A
  //   - For swapped chunks: take from B
  const blocksFromA = [];
  const blocksFromB = [];

  const countA = splatDataA.splatCount;
  for (let i = 0; i < countA; i++) {
    const cid = chunkIdsA[i];
    if (!swapFlags[cid]) {
      blocksFromA.push(splatDataA.getSplatBlock(i));
    }
  }

  const countB = splatDataB.splatCount;
  for (let i = 0; i < countB; i++) {
    const cid = chunkIdsB[i];
    if (swapFlags[cid]) {
      blocksFromB.push(splatDataB.getSplatBlock(i));
    }
  }

  // Merge into one big Uint8Array
  const totalSplats = blocksFromA.length + blocksFromB.length;
  const merged = new Uint8Array(totalSplats * 32);

  let offset = 0;
  for (const block of blocksFromA) {
    merged.set(block, offset);
    offset += 32;
  }
  for (const block of blocksFromB) {
    merged.set(block, offset);
    offset += 32;
  }

  return new SplatData(merged);
}
