/**
 * dataModel.js
 * The typed-array splat store.
 * Holds the 32-byte per splat uncompressed data.
 */

export class SplatData {
  /**
   * @param {Uint8Array} uint8Array - The raw 32-byte chunks of splats
   */
  constructor(uint8Array) {
    this.data = uint8Array;
    this.splatCount = this.data.length / 32;
  }

  getSplatBlock(index) {
    const start = index * 32;
    return this.data.subarray(start, start + 32);
  }

  setSplatBlock(index, block) {
    const start = index * 32;
    this.data.set(block, start);
  }

  // Read positions directly
  getPosition(index) {
    const start = index * 32;
    // Data view is easier for mixed types
    const dv = new DataView(this.data.buffer, this.data.byteOffset + start, 32);
    return [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true)];
  }
  
  // Set position directly
  setPosition(index, x, y, z) {
    const start = index * 32;
    const dv = new DataView(this.data.buffer, this.data.byteOffset + start, 32);
    dv.setFloat32(0, x, true);
    dv.setFloat32(4, y, true);
    dv.setFloat32(8, z, true);
  }

  getBuffer() {
    return this.data.buffer;
  }
}

/**
 * Truncates a SplatData object to a maximum number of splats,
 * keeping the ones closest to the absolute origin (0,0,0).
 */
export function limitSplatCount(splatData, maxSplats = 250000) {
  const count = splatData.splatCount;
  if (count <= maxSplats) return splatData;

  const view = new DataView(splatData.data.buffer, splatData.data.byteOffset, splatData.data.byteLength);
  
  // Calculate squared distance from origin (0,0,0) for each splat
  const distances = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = view.getFloat32(base + 0, true);
    const py = view.getFloat32(base + 4, true);
    const pz = view.getFloat32(base + 8, true);
    distances[i] = px * px + py * py + pz * pz;
  }

  // Create an array of indices and sort them by distance
  const indices = new Int32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  
  // Sort indices based on distances
  indices.sort((a, b) => distances[a] - distances[b]);

  // Create new buffer for the closest maxSplats
  const newBuffer = new Uint8Array(maxSplats * 32);
  for (let i = 0; i < maxSplats; i++) {
    const originalIndex = indices[i];
    const base = originalIndex * 32;
    newBuffer.set(splatData.data.subarray(base, base + 32), i * 32);
  }

  return new SplatData(newBuffer);
}

