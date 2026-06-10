/**
 * slice.js
 * Cuts a scene into chunks.
 */

export function sliceScene(splatData, gridX, gridY, gridZ) {
  const count = splatData.splatCount;
  const chunkIds = new Int32Array(count);
  
  // 1. Find bounding box
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  
  for (let i = 0; i < count; i++) {
    const [x, y, z] = splatData.getPosition(i);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  
  const width = maxX - minX;
  const height = maxY - minY;
  const depth = maxZ - minZ;
  
  // 2. Assign chunks based on grid
  for (let i = 0; i < count; i++) {
    const [x, y, z] = splatData.getPosition(i);
    
    const nx = Math.max(0, Math.min(1, (x - minX) / (width || 1)));
    const ny = Math.max(0, Math.min(1, (y - minY) / (height || 1)));
    const nz = Math.max(0, Math.min(1, (z - minZ) / (depth || 1)));
    
    const cx = Math.min(gridX - 1, Math.floor(nx * gridX));
    const cy = Math.min(gridY - 1, Math.floor(ny * gridY));
    const cz = Math.min(gridZ - 1, Math.floor(nz * gridZ));
    
    const chunkId = cx + (cy * gridX) + (cz * gridX * gridY);
    chunkIds[i] = chunkId;
  }
  
  return chunkIds;
}

export function debugColorChunks(splatData, chunkIds, numChunks) {
  const colors = [];
  for (let i = 0; i < numChunks; i++) {
    colors.push([
      Math.floor(Math.random() * 255),
      Math.floor(Math.random() * 255),
      Math.floor(Math.random() * 255),
      255
    ]);
  }
  
  const count = splatData.splatCount;
  for (let i = 0; i < count; i++) {
    const cid = chunkIds[i];
    const c = colors[cid];
    // Color starts at offset 24 (12 pos + 12 scale)
    const start = i * 32 + 24;
    splatData.data[start] = c[0];
    splatData.data[start + 1] = c[1];
    splatData.data[start + 2] = c[2];
    splatData.data[start + 3] = c[3];
  }
}
