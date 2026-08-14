import { SplatData } from '../dataModel.js';

export function sliceIntoSpheres(splatData, numChunks = 32) {
  if (!splatData) return [];

  const count = splatData.splatCount;
  const view = new DataView(splatData.data.buffer, splatData.data.byteOffset, splatData.data.byteLength);

  // 1. Find bounding box to determine center and max distance
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = view.getFloat32(base + 0, true);
    const py = view.getFloat32(base + 4, true);
    const pz = view.getFloat32(base + 8, true);
    
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    if (pz > maxZ) maxZ = pz;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  // Find max distance
  let maxDistSq = 0;
  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = view.getFloat32(base + 0, true) - cx;
    const py = view.getFloat32(base + 4, true) - cy;
    const pz = view.getFloat32(base + 8, true) - cz;
    const distSq = px*px + py*py + pz*pz;
    if (distSq > maxDistSq) maxDistSq = distSq;
  }
  const maxDist = Math.sqrt(maxDistSq);
  if (maxDist === 0) return [splatData]; // Single point

  // Pick random cluster centers, radii, and shape types for portions
  const shapes = [];
  for (let i = 0; i < numChunks; i++) {
    const size = maxDist * (0.3 + Math.random() * 0.4); // Random size between 30% and 70% of max size
    shapes.push({
      x: cx + (Math.random() * 2 - 1) * maxDist,
      y: cy + (Math.random() * 2 - 1) * maxDist,
      z: cz + (Math.random() * 2 - 1) * maxDist,
      size: size,
      type: Math.floor(Math.random() * 3) // 0: sphere, 1: box, 2: cylinder
    });
  }

  // 2. Count splats per chunk by checking shape containment
  const chunkCounts = new Int32Array(numChunks);
  const chunkAssignments = new Int32Array(count);

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = view.getFloat32(base + 0, true);
    const py = view.getFloat32(base + 4, true);
    const pz = view.getFloat32(base + 8, true);
    
    let assignedChunk = 0; // Default chunk for points outside all shapes
    
    // Check which shape it falls into (skip 0, it's the background)
    for (let c = 1; c < numChunks; c++) {
      const shape = shapes[c];
      const dx = px - shape.x;
      const dy = py - shape.y;
      const dz = pz - shape.z;
      
      let inside = false;
      if (shape.type === 0) {
        // Sphere
        inside = (dx*dx + dy*dy + dz*dz) <= (shape.size * shape.size);
      } else if (shape.type === 1) {
        // Box
        inside = Math.abs(dx) <= shape.size && Math.abs(dy) <= shape.size && Math.abs(dz) <= shape.size;
      } else {
        // Cylinder (along Y axis)
        inside = (dx*dx + dz*dz) <= (shape.size * shape.size) && Math.abs(dy) <= shape.size;
      }

      if (inside) {
        assignedChunk = c;
        break;
      }
    }
    
    chunkAssignments[i] = assignedChunk;
    chunkCounts[assignedChunk]++;
  }

  // 3. Allocate buffers
  const chunks = [];
  const chunkOffsets = new Int32Array(numChunks);
  for (let i = 0; i < numChunks; i++) {
    chunks.push(new Uint8Array(chunkCounts[i] * 32));
    chunkOffsets[i] = 0;
  }

  // 4. Fill buffers
  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const chunkIdx = chunkAssignments[i];
    const offset = chunkOffsets[chunkIdx];
    
    chunks[chunkIdx].set(splatData.data.subarray(base, base + 32), offset);
    chunkOffsets[chunkIdx] += 32;
  }

  // 5. Build SplatData objects with centroid metadata for ordering
  const rawChunks = chunks
    .map((buf, idx) => ({ buf, idx }))
    .filter(({ buf }) => buf.length > 0)
    .map(({ buf, idx }) => {
      const sd = new SplatData(buf);
      // Compute centroid of this chunk relative to overall center
      const cview = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const n = buf.length / 32;
      let sumX = 0, sumY = 0, sumZ = 0;
      for (let j = 0; j < n; j++) {
        const base = j * 32;
        sumX += cview.getFloat32(base + 0, true) - cx;
        sumY += cview.getFloat32(base + 4, true) - cy;
        sumZ += cview.getFloat32(base + 8, true) - cz;
      }
      const dx = sumX / n;
      const dy = sumY / n;
      const dz = sumZ / n;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Clockwise angle: negate atan2 so increasing angle goes clockwise (when viewed from above)
      const angle = -Math.atan2(dz, dx);
      return { sd, dist, angle, idx };
    });

  // Sort: outer first (dist descending), then clockwise (angle ascending after negation)
  rawChunks.sort((a, b) => {
    if (Math.abs(a.dist - b.dist) > 1e-6) return b.dist - a.dist; // outer first
    return a.angle - b.angle; // clockwise within same ring
  });

  const ordered = rawChunks.map(r => r.sd);
  // Expose how the cut was made so other representations of the same object —
  // notably a solid mesh on the same deck — can be cut into matching chunks:
  // `shapes` are the containment volumes, `order` maps each returned chunk back
  // to the shape index it came from (chunk 0 of `shapes` is the "outside
  // everything" background).
  ordered.meta = { shapes, order: rawChunks.map(r => r.idx), center: { x: cx, y: cy, z: cz } };
  return ordered;
}

/**
 * Chunk id for a point under a given slice, matching the assignment loop above.
 * @param {{shapes: Array}} meta  the `meta` attached to a sliceIntoSpheres result
 */
export function chunkIdForPoint(meta, px, py, pz) {
  const shapes = meta.shapes;
  for (let c = 1; c < shapes.length; c++) {
    const shape = shapes[c];
    const dx = px - shape.x;
    const dy = py - shape.y;
    const dz = pz - shape.z;
    if (shape.type === 0) {
      if (dx * dx + dy * dy + dz * dz <= shape.size * shape.size) return c;
    } else if (shape.type === 1) {
      if (Math.abs(dx) <= shape.size && Math.abs(dy) <= shape.size && Math.abs(dz) <= shape.size) return c;
    } else {
      if (dx * dx + dz * dz <= shape.size * shape.size && Math.abs(dy) <= shape.size) return c;
    }
  }
  return 0;
}
