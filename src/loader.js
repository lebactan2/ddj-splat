import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

/**
 * Reads a .ply or .splat file and returns a Uint8Array
 * representing the uncompressed splats (32-bytes per splat).
 */
export async function loadFileAsSplatArray(file) {
  const buffer = await file.arrayBuffer();
  let result;

  if (file.name.toLowerCase().endsWith('.ply')) {
    result = GaussianSplats3D.PlyParser.parseToUncompressedSplatArray(buffer);
  } else if (file.name.toLowerCase().endsWith('.splat')) {
    // For .splat files, the SplatParser parseToUncompressedSplatArray might just wrap it.
    if (GaussianSplats3D.SplatParser && GaussianSplats3D.SplatParser.parseToUncompressedSplatArray) {
      result = GaussianSplats3D.SplatParser.parseToUncompressedSplatArray(buffer);
    } else {
      // Fallback: it's already an uncompressed splat array.
      return new Uint8Array(buffer);
    }
  } else {
    throw new Error('Unsupported file format. Please load .ply or .splat.');
  }

  // result could be the array itself or an object containing it
  const splatArray = result.splatArray || result;
  
  if (splatArray instanceof Uint8Array) {
    return splatArray;
  }
  
  return new Uint8Array(splatArray.buffer || splatArray);
}
