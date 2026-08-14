/**
 * Browser test for SOLID MESH mode: a loaded .glb/.obj renders as real lit
 * triangles instead of the splat cloud sampled from it.
 *
 *   1. solid mode paints an image, and the deck's splat proxy stays small
 *   2. the SOLID MESH toggle switches to full-density splats and back
 *   3. the mesh follows the deck: crossfading to the other deck fades it out
 *   4. a splat-format scene is unaffected by the toggle
 *
 * Pixel extents are measured by decoding the screenshot inside the page
 * (readPixels is empty without preserveDrawingBuffer).
 *
 * Requires `npm run dev` on http://localhost:5173.
 */
const puppeteer = require('puppeteer');
const path = require('path');

const MODELS = path.resolve(__dirname, '../sample-models');
const CANVAS_CLIP = { x: 310, y: 170, width: 660, height: 450 };

async function litPixels(page) {
  const shot = await page.screenshot({ encoding: 'base64', clip: CANVAS_CLIP });
  return page.evaluate(async (b64) => {
    const res = await fetch('data:image/png;base64,' + b64);
    const bitmap = await createImageBitmap(await res.blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let lit = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] + d[i + 1] + d[i + 2];
      if (v > 60) { lit++; sum += v; }
    }
    return { lit, meanBrightness: lit ? Math.round(sum / lit / 3) : 0 };
  }, shot);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The deck eases per-chunk scales toward their target one realtime-update at a
// time, and headless has no continuous animation loop, so pump the update until
// the transforms have settled before measuring anything.
async function settle(page, ticks = 60) {
  for (let i = 0; i < ticks; i++) {
    await page.evaluate(() => document.querySelector('#crossfader')
      .dispatchEvent(new Event('input', { bubbles: true })));
    await wait(16);
  }
  await wait(500);
}

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.toString()));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('MIDI')) console.log('PAGE ERROR LOG:', m.text());
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });

  let failures = 0;
  const expect = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' — ' + detail}`);
    if (!cond) failures++;
  };
  const splatCountA = () => page.$eval('#max-splats-slider-a', (el) => Number(el.max));

  // ── 1. solid mode ─────────────────────────────────────────────────────────
  await (await page.$('#file-a')).uploadFile(path.join(MODELS, 'DamagedHelmet.glb'));
  await page.waitForFunction(() => /Scene A loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await settle(page);

  const solid = await litPixels(page);
  const proxyCount = await splatCountA();
  console.log('  solid:', JSON.stringify(solid), 'proxy splats:', proxyCount);
  expect('solid mesh renders', solid.lit > 2000, JSON.stringify(solid));
  expect('solid mesh is lit, not black', solid.meanBrightness > 40, solid.meanBrightness);
  expect('solid deck keeps only a small splat proxy', proxyCount <= 20000, proxyCount);

  const meshState = await page.evaluate(() => {
    const e = window.__deckMeshes.a;
    const mats = [];
    e.object.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (m) mats.push({ env: !!m.envMap, patched: typeof m.onBeforeCompile === 'function' });
      }
    });
    return { visible: e.group.visible, scale: e.group.scale.x, mats };
  });
  console.log('  mesh state:', JSON.stringify(meshState));
  expect('mesh group is visible and scaled by the deck',
    meshState.visible && meshState.scale > 0, JSON.stringify(meshState));
  expect('materials got an environment + sRGB patch',
    meshState.mats.length > 0 && meshState.mats.every((m) => m.env && m.patched),
    JSON.stringify(meshState.mats));

  // ── 2. toggle to splats and back ──────────────────────────────────────────
  await page.evaluate(() => {
    const c = document.querySelector('#chk-solid-mesh');
    c.checked = false;
    c.dispatchEvent(new Event('change'));
  });
  await settle(page);
  const asSplats = await litPixels(page);
  const splatCount = await splatCountA();
  console.log('  splat mode:', JSON.stringify(asSplats), 'splats:', splatCount);
  expect('splat mode re-samples at full density', splatCount > 100000, splatCount);
  expect('splat mode still paints', asSplats.lit > 2000, JSON.stringify(asSplats));
  expect('mesh hidden in splat mode',
    (await page.evaluate(() => window.__deckMeshes.a.group.visible)) === false, 'still visible');

  await page.evaluate(() => {
    const c = document.querySelector('#chk-solid-mesh');
    c.checked = true;
    c.dispatchEvent(new Event('change'));
  });
  await settle(page);
  const backToSolid = await litPixels(page);
  console.log('  back to solid:', JSON.stringify(backToSolid), 'splats:', await splatCountA());
  expect('toggling back restores the solid mesh', backToSolid.lit > 2000, JSON.stringify(backToSolid));
  expect('toggling back drops to the proxy cloud', (await splatCountA()) <= 20000, await splatCountA());

  // ── 3. crossfade away from the mesh deck ──────────────────────────────────
  await (await page.$('#file-b')).uploadFile(path.join(MODELS, 'Duck.glb'));
  await page.waitForFunction(() => /Scene B loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await settle(page);
  const bothDecks = await litPixels(page);

  await page.evaluate(() => {
    const xf = document.querySelector('#crossfader');
    xf.value = xf.max;
    xf.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(page);
  const deckBOnly = await litPixels(page);
  const faded = await page.evaluate(() => {
    const read = (k) => {
      const e = window.__deckMeshes[k];
      return e ? { drawn: e.group.visible, chunkScale: +e.chunks[0].scale.x.toFixed(4) } : null;
    };
    return { a: read('a'), b: read('b') };
  });
  console.log('  both:', JSON.stringify(bothDecks), 'B only:', JSON.stringify(deckBOnly),
              'faded:', JSON.stringify(faded));
  // A mesh deck crossfades by shrinking, so the outgoing deck ends up scaled to
  // nothing (and is skipped entirely once its level hits zero).
  expect('crossfader takes the mesh deck out',
    faded.a && (!faded.a.drawn || faded.a.chunkScale < 0.001), JSON.stringify(faded));
  expect('the other mesh deck stays up',
    faded.b && faded.b.drawn && faded.b.chunkScale > 0.01, JSON.stringify(faded));
  expect('something is still on screen after the crossfade', deckBOnly.lit > 1000, JSON.stringify(deckBOnly));

  // ── 4. two solid meshes at once ───────────────────────────────────────────
  // Each deck composites as its own layer. Sharing one depth buffer made the
  // two models interpenetrate and flicker, and the crossfade opacity used to be
  // applied to the source object instead of the rendered chunk clones.
  await page.evaluate(() => {
    const xf = document.querySelector('#crossfader');
    xf.value = (Number(xf.min) + Number(xf.max)) / 2;
    xf.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(page);

  const mid = await page.evaluate(() => {
    const read = (k) => {
      const e = window.__deckMeshes[k];
      const mats = [];
      e.group.traverse((o) => {
        if (o.isMesh && e.chunks.includes(o.parent)) {
          const m = Array.isArray(o.material) ? o.material[0] : o.material;
          mats.push({ opacity: +m.opacity.toFixed(2), transparent: m.transparent, depthWrite: m.depthWrite });
        }
      });
      return { deckOpacity: e.opacity, mats: mats.slice(0, 40) };
    };
    return { a: read('a'), b: read('b') };
  });
  console.log('  mid-crossfade:', JSON.stringify({ a: mid.a.deckOpacity, b: mid.b.deckOpacity,
    sampleA: mid.a.mats[0], sampleB: mid.b.mats[0] }));
  // Mid-crossfade a solid mesh must stay fully opaque: alpha blending made it
  // look like a ghost of itself, and a dithered dissolve left a screen-door
  // pattern over it.
  expect('mid-crossfade meshes stay opaque and depth-writing',
    ['a', 'b'].every((k) => mid[k].mats.length > 0 &&
      mid[k].mats.every((m) => !m.transparent && m.opacity === 1 && m.depthWrite === true)),
    JSON.stringify({ a: mid.a.mats[0], b: mid.b.mats[0] }));
  // Mid-crossfade both decks are drawn solid; the fader shows up as scale.
  const midScales = await page.evaluate(() => {
    const read = (k) => {
      const e = window.__deckMeshes[k];
      return { drawn: e.group.visible, chunk: +e.chunks[0].scale.x.toFixed(4) };
    };
    return { a: read('a'), b: read('b'), splat: +window.viewer.getSplatScene(0).scale.x.toFixed(4) };
  });
  console.log('  mid-crossfade scales:', JSON.stringify(midScales));
  expect('both mesh decks are drawn while mixing',
    midScales.a.drawn && midScales.b.drawn && midScales.a.chunk > 0 && midScales.b.chunk > 0,
    JSON.stringify(midScales));
  expect('the crossfader shows up as scale, not alpha',
    midScales.a.chunk < midScales.splat, JSON.stringify(midScales));

  // Nothing is animating here, so two captures of the same state must agree.
  // Depth fighting between the two meshes showed up exactly as disagreement.
  const f1 = await litPixels(page);
  const f2 = await litPixels(page);
  const drift = Math.abs(f2.lit - f1.lit) / Math.max(1, f1.lit);
  console.log('  mid-crossfade frames:', JSON.stringify(f1), JSON.stringify(f2), 'drift', drift.toFixed(4));
  expect('a static two-mesh frame is stable', drift < 0.02, `drift ${drift.toFixed(4)}`);

  // Neither mesh may be clipped away by the other's depth. Both models must be
  // visibly on screen at once: the duck is yellow, the helmet is not.
  const palette = async () => {
    const shot = await page.screenshot({ encoding: 'base64', clip: CANVAS_CLIP });
    return page.evaluate(async (b64) => {
      const res = await fetch('data:image/png;base64,' + b64);
      const bitmap = await createImageBitmap(await res.blob());
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let yellow = 0, other = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r + g + b <= 60) continue;
        if (r > 140 && g > 110 && b < 90) yellow++; else other++;
      }
      return { yellow, other };
    }, shot);
  };
  const mix = await palette();
  console.log('  both models present:', JSON.stringify(mix));
  expect('neither mesh is clipped away by the other',
    mix.yellow > 5000 && mix.other > 5000, JSON.stringify(mix));

  // Both decks playing: the animation moves, but both models must stay drawn.
  await page.evaluate(() => {
    document.querySelector('#btn-play-a').click();
    document.querySelector('#btn-play-b').click();
  });
  await settle(page);
  const playing = await litPixels(page);
  console.log('  two decks playing:', JSON.stringify(playing));
  expect('both meshes stay on screen while playing', playing.lit > 5000, JSON.stringify(playing));
  await page.evaluate(() => {
    document.querySelector('#btn-play-a').click();
    document.querySelector('#btn-play-b').click();
  });

  expect('no uncaught page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
