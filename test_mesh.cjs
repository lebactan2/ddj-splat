/**
 * Browser test for the mesh -> splat loader (src/meshLoader.js).
 *
 *   1. .obj through the real deck UI
 *   2. textured .glb through the real deck UI
 *   3. direct module test on Duck.glb: normalized bounds, finite positions,
 *      positive scales, unit quaternions, and colour variety from the texture
 *   4. .usdz round trip — the Duck scene is re-exported with three's
 *      USDZExporter and fed back through the loader
 *
 * Requires `npm run dev` on http://localhost:5173.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const MODELS = path.resolve(__dirname, '../sample-models');
const STATUS = '#status';

async function waitForStatus(page, pattern, timeout = 120000) {
  await page.waitForFunction(
    (sel, p) => new RegExp(p).test(document.querySelector(sel).textContent),
    { timeout }, STATUS, pattern);
  return page.$eval(STATUS, (el) => el.textContent);
}

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.toString()));
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error' && !t.includes('[vite]') && !t.includes('MIDI')) {
      console.log('PAGE ERROR LOG:', t);
    }
  });

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });

  let failures = 0;
  const expect = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' — ' + detail}`);
    if (!cond) failures++;
  };

  // ── 1 & 2. real deck UI ───────────────────────────────────────────────────
  for (const [deck, model] of [['a', 'cow.obj'], ['b', 'DamagedHelmet.glb'], ['a', 'stanford-bunny.fbx']]) {
    const input = await page.$(`#file-${deck}`);
    await input.uploadFile(path.join(MODELS, model));
    const status = await waitForStatus(page, `Scene ${deck.toUpperCase()} (loaded|.*Error)`)
      .catch(() => page.$eval(STATUS, (el) => el.textContent));
    expect(`${model} loads on deck ${deck.toUpperCase()}`,
      new RegExp(`Scene ${deck.toUpperCase()} loaded`).test(status), status);

    const sliderMax = await page.$eval(`#max-splats-slider-${deck}`, (el) => Number(el.max))
      .catch(() => -1);
    expect(`${model} produced splats`, sliderMax > 1000, `slider max = ${sliderMax}`);
  }

  await page.screenshot({ path: 'screenshot_mesh_decks.png' });

  // ── 3. direct module test on Duck.glb ─────────────────────────────────────
  const duckB64 = fs.readFileSync(path.join(MODELS, 'Duck.glb')).toString('base64');
  const stats = await page.evaluate(async (b64) => {
    const { loadMeshToSplatBytes } = await import('/src/meshLoader.js');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'Duck.glb', { type: 'model/gltf-binary' });

    const out = await loadMeshToSplatBytes(file, [file], { count: 20000 });
    const count = out.length / 32;
    const view = new DataView(out.buffer);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let nonFinite = 0, badScale = 0, badQuat = 0, opaque = 0;
    const colors = new Set();
    let sumX = 0, sumY = 0, sumZ = 0;

    for (let i = 0; i < count; i++) {
      const b = i * 32;
      const p = [view.getFloat32(b, true), view.getFloat32(b + 4, true), view.getFloat32(b + 8, true)];
      p.forEach((v, k) => {
        if (!Number.isFinite(v)) nonFinite++;
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      });
      sumX += p[0]; sumY += p[1]; sumZ += p[2];

      for (let k = 0; k < 3; k++) {
        const s = view.getFloat32(b + 12 + k * 4, true);
        if (!(s > 0) || !Number.isFinite(s)) badScale++;
      }
      const q = [out[b + 28], out[b + 29], out[b + 30], out[b + 31]].map((v) => v / 127.5 - 1);
      const norm = Math.hypot(q[0], q[1], q[2], q[3]);
      if (Math.abs(norm - 1) > 0.06) badQuat++;
      if (out[b + 27] > 200) opaque++;
      colors.add(`${out[b + 24]},${out[b + 25]},${out[b + 26]}`);
    }

    return {
      count, nonFinite, badScale, badQuat, opaque,
      distinctColors: colors.size,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      mean: [sumX / count, sumY / count, sumZ / count],
      radius: view.getFloat32(12, true),
    };
  }, duckB64);

  console.log('  Duck.glb stats:', JSON.stringify(stats));
  expect('Duck: requested splat count', stats.count === 20000, stats.count);
  expect('Duck: all positions finite', stats.nonFinite === 0, `${stats.nonFinite} non-finite`);
  expect('Duck: all scales positive', stats.badScale === 0, `${stats.badScale} bad`);
  expect('Duck: quaternions unit length', stats.badQuat === 0, `${stats.badQuat} bad`);
  expect('Duck: opaque splats', stats.opaque > stats.count * 0.9, stats.opaque);
  expect('Duck: normalized to ~16 units',
    Math.abs(Math.max(...stats.size) - 16) < 0.2, JSON.stringify(stats.size));
  expect('Duck: centred on origin',
    stats.center.every((c) => Math.abs(c) < 0.2), JSON.stringify(stats.center));
  expect('Duck: texture colours sampled', stats.distinctColors > 20, stats.distinctColors);
  expect('Duck: disc radius sane',
    stats.radius > 0 && stats.radius < 0.6, stats.radius);

  // ── 4. .usdz round trip ───────────────────────────────────────────────────
  const usdzStats = await page.evaluate(async (b64) => {
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { USDZExporter } = await import('/node_modules/three/examples/jsm/exporters/USDZExporter.js');
    const { loadMeshToSplatBytes } = await import('/src/meshLoader.js');

    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(bytes.buffer, '', res, rej));
    const usdz = await new USDZExporter().parseAsync(gltf.scene);
    const file = new File([usdz], 'duck.usdz', { type: 'model/vnd.usdz+zip' });

    const out = await loadMeshToSplatBytes(file, [file], { count: 5000 });
    const view = new DataView(out.buffer);
    const count = out.length / 32;
    let nonFinite = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = view.getFloat32(i * 32 + k * 4, true);
        if (!Number.isFinite(v)) nonFinite++;
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    return { count, nonFinite, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
  }, duckB64).catch((e) => ({ error: e.message }));

  console.log('  usdz stats:', JSON.stringify(usdzStats));
  expect('.usdz round trip decodes',
    !usdzStats.error && usdzStats.count === 5000 && usdzStats.nonFinite === 0,
    usdzStats.error || JSON.stringify(usdzStats));

  // ── 5. .gltf with an external .bin, resolved from the same selection ──────
  const gltfStats = await page.evaluate(async (b64) => {
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { GLTFExporter } = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
    const { loadMeshToSplatBytes } = await import('/src/meshLoader.js');

    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(bytes.buffer, '', res, rej));

    // Export as JSON glTF, then split the embedded buffer out into a sibling
    // .bin so the loader has to resolve a companion file to succeed.
    const json = await new GLTFExporter().parseAsync(gltf.scene, { binary: false });
    const uri = json.buffers[0].uri;
    const raw = atob(uri.slice(uri.indexOf(',') + 1));
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    json.buffers[0].uri = 'duck_data.bin';

    const gltfFile = new File([JSON.stringify(json)], 'duck.gltf', { type: 'model/gltf+json' });
    const binFile = new File([buf], 'duck_data.bin', { type: 'application/octet-stream' });

    const out = await loadMeshToSplatBytes(gltfFile, [gltfFile, binFile], { count: 5000 });
    const view = new DataView(out.buffer);
    const count = out.length / 32;
    let nonFinite = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = view.getFloat32(i * 32 + k * 4, true);
        if (!Number.isFinite(v)) nonFinite++;
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    return { count, nonFinite, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
  }, duckB64).catch((e) => ({ error: e.message }));

  console.log('  gltf+bin stats:', JSON.stringify(gltfStats));
  expect('.gltf with external .bin decodes',
    !gltfStats.error && gltfStats.count === 5000 && gltfStats.nonFinite === 0,
    gltfStats.error || JSON.stringify(gltfStats));

  expect('no uncaught page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
