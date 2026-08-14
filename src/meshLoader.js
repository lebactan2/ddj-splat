/**
 * meshLoader.js
 * Loads ordinary polygon meshes (.obj, .fbx, .usdz, .gltf, .glb) and converts
 * them into gaussian splats, so a deck can hold a regular 3D model alongside
 * real splat captures.
 *
 * Conversion is area-weighted surface sampling: every triangle of the merged,
 * world-transformed mesh contributes points in proportion to its area, so the
 * point density is uniform across the surface regardless of tessellation.
 * Each sample becomes one flat, disc-shaped gaussian lying in the surface:
 *
 *   position  barycentric point on the triangle
 *   rotation  local +Z aligned to the interpolated surface normal
 *   scale     (r, r, r * DISC_FLATNESS) where r is derived from the sample
 *             spacing, so neighbouring discs overlap slightly and the surface
 *             reads as solid rather than as loose dots
 *   colour    texture lookup at the interpolated UV, else vertex colour,
 *             else the material's base colour
 *
 * Companion files (an .mtl for an .obj, or the .bin and texture images of a
 * non-embedded .gltf) are resolved from the same selection through a
 * LoadingManager URL modifier backed by blob URLs.
 *
 * Output is the app's 32-byte-per-splat ".splat" layout, matching the other
 * loaders in this project.
 */

import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { USDZLoader } from 'three/examples/jsm/loaders/USDZLoader.js';

export const MESH_EXTS = ['.obj', '.fbx', '.usdz', '.gltf', '.glb'];

const DEFAULT_SAMPLE_COUNT = 300000;
const DISC_FLATNESS = 0.12;  // thickness of a splat relative to its radius
const DISC_OVERLAP = 1.6;    // radius multiplier so neighbouring discs meet
// Largest dimension of the loaded model, in scene units. Measured against the
// deck framing: at 16 the model fills roughly half the viewport height, which
// matches how a typical splat capture sits in frame.
const NORMALIZE_SIZE = 16.0;

/** Lowercased extension including the dot, or '' if the name has none. */
export function extensionOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

export function isMeshFile(name) {
  return MESH_EXTS.includes(extensionOf(name));
}

function baseName(path) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return (i === -1 ? path : path.slice(i + 1)).toLowerCase();
}

/**
 * A LoadingManager that resolves any requested URL to a sibling file from the
 * same selection, matched on filename. Call dispose() to revoke the blob URLs.
 */
function makeSiblingManager(files) {
  const manager = new THREE.LoadingManager();
  const urls = new Map();

  for (const f of files) {
    const key = baseName(f.name);
    if (!urls.has(key)) urls.set(key, URL.createObjectURL(f));
  }

  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    // Strip any query/fragment before matching on the bare filename.
    const clean = url.split(/[?#]/)[0];
    return urls.get(baseName(clean)) ?? url;
  });

  manager.dispose = () => { for (const u of urls.values()) URL.revokeObjectURL(u); };
  return manager;
}

/** Parse one mesh file (plus its siblings) into a THREE.Object3D. */
async function parseMesh(file, siblings) {
  const ext = extensionOf(file.name);
  const manager = makeSiblingManager(siblings.filter((f) => f !== file));

  try {
    if (ext === '.obj') {
      const loader = new OBJLoader(manager);
      // An .mtl in the same selection gives the model its materials/textures.
      const mtlFile = siblings.find((f) => extensionOf(f.name) === '.mtl');
      if (mtlFile) {
        const materials = new MTLLoader(manager).parse(await mtlFile.text(), '');
        materials.preload();
        loader.setMaterials(materials);
      }
      return loader.parse(await file.text());
    }

    if (ext === '.fbx') {
      return new FBXLoader(manager).parse(await file.arrayBuffer(), '');
    }

    if (ext === '.usdz') {
      return new USDZLoader(manager).parse(await file.arrayBuffer());
    }

    if (ext === '.gltf' || ext === '.glb') {
      const loader = new GLTFLoader(manager);
      // .glb is binary; .gltf is JSON, which parse() also accepts as a string.
      const data = ext === '.glb' ? await file.arrayBuffer() : await file.text();
      const gltf = await new Promise((resolve, reject) => loader.parse(data, '', resolve, reject));
      return gltf.scene;
    }

    throw new Error(`Unsupported mesh format "${ext}"`);
  } finally {
    // Textures decode from the blob URLs synchronously during parse for the
    // formats above; revoke on the next tick so nothing races the loaders.
    setTimeout(() => manager.dispose(), 5000);
  }
}

/** Read a material's texture into an ImageData we can sample per point. */
function textureToImageData(texture) {
  const image = texture?.image;
  if (!image) return null;

  const width = image.width || image.videoWidth;
  const height = image.height || image.videoHeight;
  if (!width || !height) return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, width, height);
  } catch (e) {
    // Cross-origin or otherwise untainted-canvas failures fall back to flat colour.
    console.warn('[mesh] texture could not be read, using base colour:', e.message);
    return null;
  }
}

/** Base colour of a material as sRGB bytes. */
function materialColorBytes(material) {
  const c = material?.color ? material.color.clone() : new THREE.Color(0xffffff);
  // three keeps material colours in linear working space; splat colours are
  // display-space bytes, so convert before quantising.
  c.convertLinearToSRGB();
  return [
    Math.round(Math.max(0, Math.min(1, c.r)) * 255),
    Math.round(Math.max(0, Math.min(1, c.g)) * 255),
    Math.round(Math.max(0, Math.min(1, c.b)) * 255),
  ];
}

/**
 * Flatten a scene graph into per-mesh sampling records with world transforms
 * baked into the positions and normals.
 */
function collectSurfaces(root) {
  root.updateMatrixWorld(true);

  const surfaces = [];
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;

    const geometry = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone();
    const position = geometry.getAttribute('position');
    if (!position || position.count < 3) return;

    geometry.applyMatrix4(obj.matrixWorld);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

    const material = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    surfaces.push({
      position: geometry.getAttribute('position'),
      normal: geometry.getAttribute('normal'),
      uv: geometry.getAttribute('uv'),
      color: material?.vertexColors ? geometry.getAttribute('color') : null,
      baseColor: materialColorBytes(material),
      map: textureToImageData(material?.map),
      opacity: material?.transparent && Number.isFinite(material.opacity) ? material.opacity : 1,
    });
  });

  return surfaces;
}

/** Cumulative triangle areas across all surfaces, for area-weighted picking. */
function buildAreaTable(surfaces) {
  const triSurface = [];
  const triIndex = [];
  const cumulative = [];
  let total = 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (let s = 0; s < surfaces.length; s++) {
    const pos = surfaces[s].position;
    const triCount = Math.floor(pos.count / 3);
    for (let t = 0; t < triCount; t++) {
      const i = t * 3;
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const area = cross.crossVectors(ab, ac).length() * 0.5;
      if (!(area > 0) || !Number.isFinite(area)) continue; // skip degenerate triangles
      total += area;
      triSurface.push(s);
      triIndex.push(i);
      cumulative.push(total);
    }
  }

  return { triSurface, triIndex, cumulative: Float64Array.from(cumulative), total };
}

/** Index of the first cumulative entry >= value (binary search). */
function pickTriangle(cumulative, value) {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Cut a loaded mesh into the same chunks the deck cut its splats into.
 *
 * The splat slicer assigns every point to the first random volume that contains
 * it (see cutup/xyz_shuffle.js) and returns the chunks sorted outer→inner. Here
 * each triangle is assigned by its centroid under the identical test and the
 * results are emitted in the identical order, so mesh chunk i and splat scene i
 * are the same piece of the object and can share one transform.
 *
 * Triangles are assigned whole (no clipping), so a chunk boundary follows the
 * tessellation rather than the exact volume surface — visible only on very
 * coarse meshes.
 *
 * @param {THREE.Object3D} root       normalized mesh, as returned by loadMeshObject
 * @param {{shapes: Array, order: number[]}} meta  from the sliceIntoSpheres result
 * @returns {THREE.Group[]} one group per chunk, in the slicer's order, with the
 *          world transform baked in so a group sits at identity
 */
export function sliceObjectIntoChunkGroups(root, meta, chunkIdForPoint) {
  root.updateMatrixWorld(true);

  const groups = meta.order.map(() => new THREE.Group());
  // Original shape index -> position in the returned (sorted) chunk list.
  const slotOfShape = new Map();
  meta.order.forEach((shapeIdx, slot) => slotOfShape.set(shapeIdx, slot));

  const worldPos = new THREE.Vector3();

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;

    const geometry = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone();
    geometry.applyMatrix4(obj.matrixWorld);
    const position = geometry.getAttribute('position');
    if (!position || position.count < 3) return;

    const triCount = Math.floor(position.count / 3);
    // Bucket triangle indices per chunk slot first, then build one geometry per
    // non-empty slot — far cheaper than growing arrays per triangle.
    const buckets = new Map();
    for (let t = 0; t < triCount; t++) {
      const i = t * 3;
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) {
        worldPos.fromBufferAttribute(position, i + k);
        cx += worldPos.x; cy += worldPos.y; cz += worldPos.z;
      }
      const shapeIdx = chunkIdForPoint(meta, cx / 3, cy / 3, cz / 3);
      // A volume that caught no splats has no scene to ride on; its triangles
      // fall back to the background chunk, which always exists.
      const slot = slotOfShape.has(shapeIdx) ? slotOfShape.get(shapeIdx) : (slotOfShape.get(0) ?? 0);
      let bucket = buckets.get(slot);
      if (!bucket) { bucket = []; buckets.set(slot, bucket); }
      bucket.push(i);
    }

    const attrNames = Object.keys(geometry.attributes);
    for (const [slot, tris] of buckets) {
      const sub = new THREE.BufferGeometry();
      for (const name of attrNames) {
        const src = geometry.getAttribute(name);
        const itemSize = src.itemSize;
        const dst = new Float32Array(tris.length * 3 * itemSize);
        let w = 0;
        for (const i of tris) {
          for (let k = 0; k < 3; k++) {
            for (let c = 0; c < itemSize; c++) {
              dst[w++] = src.array[(i + k) * itemSize + c];
            }
          }
        }
        sub.setAttribute(name, new THREE.BufferAttribute(dst, itemSize));
      }
      const piece = new THREE.Mesh(sub, obj.material);
      piece.frustumCulled = false; // chunks are moved per frame by the deck
      groups[slot].add(piece);
    }

    geometry.dispose();
  });

  return groups;
}

/** Nearest-texel lookup, with the usual repeat wrap and flipped V. */
function sampleTexture(imageData, u, v, out) {
  const { width, height, data } = imageData;
  let x = Math.floor((u - Math.floor(u)) * width);
  let y = Math.floor((1 - (v - Math.floor(v))) * height);
  if (x < 0) x = 0; else if (x >= width) x = width - 1;
  if (y < 0) y = 0; else if (y >= height) y = height - 1;
  const o = (y * width + x) * 4;
  out[0] = data[o];
  out[1] = data[o + 1];
  out[2] = data[o + 2];
  out[3] = data[o + 3];
}

function quaternionByte(v) {
  let b = Math.round((v * 0.5 + 0.5) * 255);
  if (b < 0) b = 0; else if (b > 255) b = 255;
  return b;
}

/**
 * Load a mesh file into a normalized THREE.Object3D: centred on the origin with
 * its largest dimension spanning NORMALIZE_SIZE, so a 500-unit CAD export and a
 * 0.02-unit game asset both arrive at the size the decks frame their scenes for.
 * The splats sampled from it share these coordinates exactly, so the solid mesh
 * and its splat proxy occupy the same space.
 *
 * @param {File} file          the mesh itself
 * @param {File[]} [siblings]  every file in the same selection (.mtl/.bin/textures)
 * @returns {Promise<THREE.Object3D>}
 */
export async function loadMeshObject(file, siblings = [file]) {
  const root = await parseMesh(file, siblings);
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) throw new Error('No mesh geometry found in that file');
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = (Number.isFinite(maxDim) && maxDim > 0) ? NORMALIZE_SIZE / maxDim : 1;

  // Wrap rather than mutate: the loaded hierarchy keeps its own transforms and
  // the wrapper carries the normalization.
  const wrapper = new THREE.Group();
  wrapper.name = 'vvj-mesh';
  root.position.sub(center);
  wrapper.add(root);
  wrapper.scale.setScalar(scale);
  wrapper.updateMatrixWorld(true);
  return wrapper;
}

/**
 * Convert a mesh file into splat bytes.
 * @param {File} file            the mesh itself
 * @param {File[]} [siblings]    every file in the same selection (for .mtl/.bin/textures)
 * @param {{count?: number}} [opts]
 * @returns {Promise<Uint8Array>} 32 bytes per splat
 */
export async function loadMeshToSplatBytes(file, siblings = [file], opts = {}) {
  return sampleObjectToSplatBytes(await loadMeshObject(file, siblings), opts);
}

/**
 * Area-weighted surface sampling of an already-loaded (and normalized) object.
 * @param {THREE.Object3D} root
 * @param {{count?: number}} [opts]
 * @returns {Uint8Array} 32 bytes per splat
 */
export function sampleObjectToSplatBytes(root, opts = {}) {
  const surfaces = collectSurfaces(root);
  if (!surfaces.length) throw new Error('No mesh geometry found in that file');

  const { triSurface, triIndex, cumulative, total } = buildAreaTable(surfaces);
  if (!triIndex.length || !(total > 0)) throw new Error('Mesh has no triangles with area');

  const count = Math.max(1000, Math.floor(opts.count || DEFAULT_SAMPLE_COUNT));

  // Sample spacing on the surface sets the disc radius: with `count` points
  // spread over `total` area, each point owns total/count of it.
  const radius = Math.sqrt(total / count) * DISC_OVERLAP * 0.5;

  const out = new Uint8Array(count * 32);
  const outView = new DataView(out.buffer);

  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const pc = new THREE.Vector3();
  const na = new THREE.Vector3();
  const nb = new THREE.Vector3();
  const nc = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const quat = new THREE.Quaternion();
  const texel = [255, 255, 255, 255];
  const vcol = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const t = pickTriangle(cumulative, Math.random() * total);
    const surface = surfaces[triSurface[t]];
    const idx = triIndex[t];

    // Uniform barycentric sample over the triangle.
    let u = Math.random();
    let v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;

    pa.fromBufferAttribute(surface.position, idx);
    pb.fromBufferAttribute(surface.position, idx + 1);
    pc.fromBufferAttribute(surface.position, idx + 2);
    const px = pa.x * w + pb.x * u + pc.x * v;
    const py = pa.y * w + pb.y * u + pc.y * v;
    const pz = pa.z * w + pb.z * u + pc.z * v;

    const base = i * 32;
    outView.setFloat32(base, px, true);
    outView.setFloat32(base + 4, py, true);
    outView.setFloat32(base + 8, pz, true);

    // ── Orientation: the thin axis of the disc follows the surface normal ──
    na.fromBufferAttribute(surface.normal, idx);
    nb.fromBufferAttribute(surface.normal, idx + 1);
    nc.fromBufferAttribute(surface.normal, idx + 2);
    normal.set(
      na.x * w + nb.x * u + nc.x * v,
      na.y * w + nb.y * u + nc.y * v,
      na.z * w + nb.z * u + nc.z * v,
    );
    if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1); else normal.normalize();
    quat.setFromUnitVectors(zAxis, normal);

    outView.setFloat32(base + 12, radius, true);
    outView.setFloat32(base + 16, radius, true);
    outView.setFloat32(base + 20, radius * DISC_FLATNESS, true);

    // ── Colour: texture, then vertex colour, then material base colour ──
    let r = surface.baseColor[0];
    let g = surface.baseColor[1];
    let b = surface.baseColor[2];
    let alpha = 255;

    if (surface.map && surface.uv) {
      const uvA = surface.uv;
      const su = uvA.getX(idx) * w + uvA.getX(idx + 1) * u + uvA.getX(idx + 2) * v;
      const sv = uvA.getY(idx) * w + uvA.getY(idx + 1) * u + uvA.getY(idx + 2) * v;
      sampleTexture(surface.map, su, sv, texel);
      // Modulate the texture by the base colour, as the renderer would.
      r = (texel[0] * r) / 255;
      g = (texel[1] * g) / 255;
      b = (texel[2] * b) / 255;
      alpha = texel[3];
    } else if (surface.color) {
      const ca = surface.color;
      vcol.setRGB(
        ca.getX(idx) * w + ca.getX(idx + 1) * u + ca.getX(idx + 2) * v,
        ca.getY(idx) * w + ca.getY(idx + 1) * u + ca.getY(idx + 2) * v,
        ca.getZ(idx) * w + ca.getZ(idx + 1) * u + ca.getZ(idx + 2) * v,
      );
      vcol.convertLinearToSRGB();
      r = vcol.r * 255;
      g = vcol.g * 255;
      b = vcol.b * 255;
    }

    out[base + 24] = Math.max(0, Math.min(255, Math.round(r)));
    out[base + 25] = Math.max(0, Math.min(255, Math.round(g)));
    out[base + 26] = Math.max(0, Math.min(255, Math.round(b)));
    out[base + 27] = Math.max(0, Math.min(255, Math.round(alpha * surface.opacity)));

    // Stored order is w, x, y, z, matching the other loaders.
    out[base + 28] = quaternionByte(quat.w);
    out[base + 29] = quaternionByte(quat.x);
    out[base + 30] = quaternionByte(quat.y);
    out[base + 31] = quaternionByte(quat.z);
  }

  return out;
}
