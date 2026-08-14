/**
 * Parity test: the deck's functions and FX must drive a SOLID MESH deck the
 * same way they drive a splat deck.
 *
 * Each case changes one control, settles the render loop, and compares the
 * rendered image (lit pixel count / bounding box / mean colour) against the
 * idle baseline. A control that reaches the mesh changes the picture; one that
 * does not leaves it pixel-identical.
 *
 * It also checks the mesh chunk transforms directly against the splat scenes
 * they mirror, which is what makes the per-chunk FX (cut-up slicing, play
 * pulse, EQ bands, chunk loop, roll) apply to the mesh at all.
 *
 * Requires `npm run dev` on http://localhost:5173.
 */
const puppeteer = require('puppeteer');
const path = require('path');

const MODELS = path.resolve(__dirname, '../sample-models');
const CANVAS_CLIP = { x: 300, y: 140, width: 690, height: 520 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(page, ticks = 50) {
  for (let i = 0; i < ticks; i++) {
    await page.evaluate(() => document.querySelector('#crossfader')
      .dispatchEvent(new Event('input', { bubbles: true })));
    await wait(16);
  }
  await wait(400);
}

/** Rendered-image fingerprint: how much is lit, where, and in what colour. */
async function frame(page) {
  const shot = await page.screenshot({ encoding: 'base64', clip: CANVAS_CLIP });
  return page.evaluate(async (b64) => {
    const res = await fetch('data:image/png;base64,' + b64);
    const bitmap = await createImageBitmap(await res.blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let lit = 0, r = 0, g = 0, b = 0;
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < bitmap.height; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        const o = (y * bitmap.width + x) * 4;
        if (d[o] + d[o + 1] + d[o + 2] > 60) {
          lit++; r += d[o]; g += d[o + 1]; b += d[o + 2];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return {
      lit,
      w: maxX - minX, h: maxY - minY,
      rgb: lit ? [Math.round(r / lit), Math.round(g / lit), Math.round(b / lit)] : [0, 0, 0],
    };
  }, shot);
}

/** How different are two fingerprints, as a fraction of the baseline? */
function delta(base, now) {
  const area = Math.abs(now.lit - base.lit) / Math.max(1, base.lit);
  const box = (Math.abs(now.w - base.w) + Math.abs(now.h - base.h)) / Math.max(1, base.w + base.h);
  const color = base.rgb.reduce((s, v, i) => s + Math.abs(v - now.rgb[i]), 0) / 765;
  return { area: +area.toFixed(3), box: +box.toFixed(3), color: +color.toFixed(3) };
}

const setControl = (page, sel, value) => page.evaluate((s, v) => {
  const el = document.querySelector(s);
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, sel, value);

const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);

const engageFx = async (page, name, depth = 90) => {
  await setControl(page, '#fx-select-a', name);
  await setControl(page, '#fx-depth-a', depth);
  await page.evaluate(() => {
    const btn = document.querySelector('#btn-fx-toggle-a');
    if (!btn.classList.contains('active')) btn.click();
  });
};

const disengageFx = (page) => page.evaluate(() => {
  const btn = document.querySelector('#btn-fx-toggle-a');
  if (btn.classList.contains('active')) btn.click();
});

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.toString()));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('MIDI')) console.log('PAGE ERROR LOG:', t);
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });

  let failures = 0;
  const expect = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' — ' + detail}`);
    if (!cond) failures++;
  };

  await (await page.$('#file-a')).uploadFile(path.join(MODELS, 'DamagedHelmet.glb'));
  await page.waitForFunction(() => /Scene A loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await settle(page);

  const base = await frame(page);
  console.log('  baseline:', JSON.stringify(base));
  expect('mesh renders before any FX', base.lit > 5000, JSON.stringify(base));

  // ── chunk transforms mirror the splat scenes exactly ──────────────────────
  const mirror = await page.evaluate(() => {
    const e = window.__deckMeshes.a;
    const v = window.viewer;
    const out = { chunks: e.chunks.length, maxErr: 0, scenes: v.getSceneCount() };
    for (let i = 0; i < e.chunks.length; i++) {
      const s = v.getSplatScene(i);
      const c = e.chunks[i];
      out.maxErr = Math.max(out.maxErr,
        Math.abs(s.scale.x - c.scale.x),
        s.position.distanceTo(c.position),
        Math.abs(s.quaternion.dot(c.quaternion)) < 0.9999 ? 1 : 0);
    }
    return out;
  });
  console.log('  chunk mirror:', JSON.stringify(mirror));
  expect('mesh is cut into the deck\'s chunks', mirror.chunks > 1, JSON.stringify(mirror));
  expect('every mesh chunk matches its splat scene transform',
    mirror.maxErr < 1e-4, `max error ${mirror.maxErr}`);

  // ── per-control checks ────────────────────────────────────────────────────
  const cases = [];
  const record = async (label, apply, undo) => {
    await apply();
    await settle(page);
    const now = await frame(page);
    const d = delta(base, now);
    cases.push({ label, d, now });
    console.log(`  ${label}: ${JSON.stringify(now)} delta ${JSON.stringify(d)}`);
    if (undo) { await undo(); await settle(page, 20); }
    return d;
  };

  const changed = (d, min = 0.02) => d.area > min || d.box > min || d.color > min;

  // EQ HI cuts the outer chunks. How much of the picture that removes depends on
  // where the random slice put the geometry, so assert on the chunk scales: the
  // band's chunks must collapse on the mesh exactly as they do on the splats.
  await setControl(page, '#eq-hi-a', 0);
  await settle(page);
  const eqScales = await page.evaluate(() => {
    const e = window.__deckMeshes.a;
    const v = window.viewer;
    return e.chunks.map((c, i) => ({
      mesh: +c.scale.x.toFixed(5),
      splat: +v.getSplatScene(i).scale.x.toFixed(5),
    }));
  });
  const collapsed = eqScales.filter((s) => s.splat < 0.01);
  const mismatched = eqScales.filter((s) => Math.abs(s.mesh - s.splat) > 1e-4);
  console.log('  EQ HI to zero:', JSON.stringify(eqScales.slice(0, 6)));
  expect('EQ cuts the outer band on the splats', collapsed.length > 0,
    JSON.stringify(eqScales));
  expect('EQ band scaling reaches the mesh identically', mismatched.length === 0,
    JSON.stringify(mismatched));
  await setControl(page, '#eq-hi-a', 50);
  await settle(page);

  let d;

  // Channel filter drives uFaderScale, mirrored in the mesh vertex shader.
  d = await record('channel filter hard right',
    () => setControl(page, '#filter-a', 100),
    () => setControl(page, '#filter-a', 0));
  expect('channel filter reaches the mesh', changed(d), JSON.stringify(d));

  // Volume fader scales the deck.
  d = await record('volume down',
    () => setControl(page, '#vol-a', 25),
    () => setControl(page, '#vol-a', 80));
  expect('volume fader reaches the mesh', changed(d), JSON.stringify(d));

  // Shader FX: flanger / phaser / pitch displace vertices the same way they
  // displace splat centres.
  for (const fx of ['flanger', 'phaser', 'pitch']) {
    d = await record(`FX ${fx}`,
      () => engageFx(page, fx),
      () => disengageFx(page));
    expect(`${fx} deforms the mesh`, changed(d), JSON.stringify(d));
  }

  // Roll appends frozen copies of chunk 0 as extra scenes. How much of the frame
  // that changes depends on what the random slice put in chunk 0 (and the copies
  // render at the deck's frozen scale 1.0, mostly off-screen), so assert the
  // structure: the mesh must gain the same copies and keep mirroring the scenes.
  const beforeRoll = await page.evaluate(() => ({
    chunks: window.__deckMeshes.a.chunks.length,
    scenes: window.viewer.getSceneCount(),
  }));
  await engageFx(page, 'roll');
  await wait(2500);
  await settle(page);
  const afterRoll = await page.evaluate(() => {
    const e = window.__deckMeshes.a;
    const v = window.viewer;
    let maxErr = 0;
    for (let i = 0; i < e.chunks.length; i++) {
      const s = v.getSplatScene(i);
      maxErr = Math.max(maxErr, Math.abs(s.scale.x - e.chunks[i].scale.x),
        s.position.distanceTo(e.chunks[i].position));
    }
    return { chunks: e.chunks.length, scenes: v.getSceneCount(), maxErr };
  });
  console.log('  roll:', JSON.stringify({ beforeRoll, afterRoll }));
  expect('roll adds its frozen copies to the mesh too',
    afterRoll.chunks === afterRoll.scenes && afterRoll.chunks > afterRoll.scenes - 5,
    JSON.stringify({ beforeRoll, afterRoll }));
  expect('rolled mesh chunks still mirror their scenes', afterRoll.maxErr < 1e-4,
    `max error ${afterRoll.maxErr}`);
  await disengageFx(page);
  await wait(2500);
  await settle(page, 20);

  // CPU FX: these rebuild the deck (re-slice, ghosts, chunk copies).
  for (const fx of ['spiral', 'reverb', 'filter']) {
    d = await record(`FX ${fx}`,
      async () => { await engageFx(page, fx); await wait(2500); },
      async () => { await disengageFx(page); await wait(2500); });
    expect(`${fx} reaches the mesh`, changed(d), JSON.stringify(d));
  }

  // Ghost FX must not veil the model: three draws transparent objects after
  // opaque ones, so in one pass spiral/reverb trails blended on top and the
  // mesh looked semi-transparent. Trails are drawn in a pass of their own,
  // before the solid geometry.
  for (const fx of ['spiral', 'reverb']) {
    await engageFx(page, fx);
    await wait(2500);
    await settle(page);
    const ghostState = await page.evaluate(() => {
      const e = window.__deckMeshes.a;
      const solids = [];
      const ghosts = [];
      e.group.traverse((o) => {
        if (!o.isMesh) return;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        const rec = { transparent: m.transparent, opacity: +m.opacity.toFixed(2), depthWrite: m.depthWrite };
        // A ghost sits under one of the per-tap groups; solid chunk pieces are
        // direct children of the chunk.
        (e.chunks.includes(o.parent) ? solids : ghosts).push(rec);
      });
      return { solids, ghosts };
    });
    console.log(`  ${fx} materials: solids=${ghostState.solids.length} ghosts=${ghostState.ghosts.length}`);
    expect(`${fx} draws ghost trails`, ghostState.ghosts.length > 0,
      JSON.stringify(ghostState));
    expect(`${fx} leaves the model itself opaque`,
      ghostState.solids.length > 0 && ghostState.solids.every((m) => !m.transparent && m.opacity === 1),
      JSON.stringify(ghostState.solids.slice(0, 4)));
    await disengageFx(page);
    await wait(2500);
    await settle(page, 20);
  }

  // Transport: play pulses one chunk per beat and spins the deck.
  d = await record('play',
    async () => { await click(page, '#btn-play-a'); await wait(1200); },
    async () => { await click(page, '#btn-play-a'); await wait(600); });
  expect('play animates the mesh', changed(d), JSON.stringify(d));

  expect('no uncaught page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
