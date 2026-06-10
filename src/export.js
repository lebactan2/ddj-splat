/**
 * export.js
 * Writes the current SplatData back to a downloadable .ply file.
 */

export function exportToPly(splatData) {
  const count = splatData.splatCount;

  // Build PLY header
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${count}`,
    'property float x',
    'property float y',
    'property float z',
    'property float scale_0',
    'property float scale_1',
    'property float scale_2',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'property uchar alpha',
    'property float rot_0',
    'property float rot_1',
    'property float rot_2',
    'property float rot_3',
    'end_header\n',
  ].join('\n');

  const headerBytes = new TextEncoder().encode(header);

  // Each vertex: 3 floats (pos) + 3 floats (scale) + 4 bytes (color) + 4 floats (rot)
  // = 12 + 12 + 4 + 16 = 44 bytes per vertex
  const vertexBytes = 44;
  const buffer = new ArrayBuffer(headerBytes.length + count * vertexBytes);
  const out = new Uint8Array(buffer);
  out.set(headerBytes, 0);

  const view = new DataView(buffer);
  let offset = headerBytes.length;

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const dv = new DataView(splatData.data.buffer, splatData.data.byteOffset + base, 32);

    // Position (3 floats)
    view.setFloat32(offset + 0, dv.getFloat32(0, true), true);
    view.setFloat32(offset + 4, dv.getFloat32(4, true), true);
    view.setFloat32(offset + 8, dv.getFloat32(8, true), true);

    // Scale (3 floats)
    view.setFloat32(offset + 12, dv.getFloat32(12, true), true);
    view.setFloat32(offset + 16, dv.getFloat32(16, true), true);
    view.setFloat32(offset + 20, dv.getFloat32(20, true), true);

    // Color (4 uint8: RGBA)
    out[offset + 24] = splatData.data[base + 24];
    out[offset + 25] = splatData.data[base + 25];
    out[offset + 26] = splatData.data[base + 26];
    out[offset + 27] = splatData.data[base + 27];

    // Rotation (4 floats from packed uint8)
    // .splat format stores rotation as 4 uint8 values mapping [0,255] → [-1,1]
    const qw = (splatData.data[base + 28] / 255) * 2 - 1;
    const qx = (splatData.data[base + 29] / 255) * 2 - 1;
    const qy = (splatData.data[base + 30] / 255) * 2 - 1;
    const qz = (splatData.data[base + 31] / 255) * 2 - 1;
    view.setFloat32(offset + 28, qw, true);
    view.setFloat32(offset + 32, qx, true);
    view.setFloat32(offset + 36, qy, true);
    view.setFloat32(offset + 40, qz, true);

    offset += vertexBytes;
  }

  // Trigger download
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'collage.ply';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
