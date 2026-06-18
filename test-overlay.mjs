import puppeteer from 'puppeteer';

const URL = 'http://localhost:5173/';
const SOG = 'C:/Cut up splatting/Raspberry.sog';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const errors = [];
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
await sleep(1000);

// Helper to read render state from the page.
const readState = () => page.evaluate(() => {
  const v = window.viewer;
  const u = v && v.splatMesh && v.splatMesh.material && v.splatMesh.material.uniforms;
  const cams = window._camRig && window._camRig.deckCameras;
  return {
    hasViewer: !!v,
    sceneCount: v && v.splatMesh ? v.splatMesh.getSceneCount() : 0,
    uA: u && u.uStrobeAlphaA ? u.uStrobeAlphaA.value : null,
    uB: u && u.uStrobeAlphaB ? u.uStrobeAlphaB.value : null,
    camA: cams && cams.a ? cams.a.position.toArray().map(n=>+n.toFixed(3)) : null,
    camB: cams && cams.b ? cams.b.position.toArray().map(n=>+n.toFixed(3)) : null,
    ovA: window._lastOverlayOpacity ? +window._lastOverlayOpacity.a.toFixed(3) : null,
    ovB: window._lastOverlayOpacity ? +window._lastOverlayOpacity.b.toFixed(3) : null,
  };
});

// Upload to deck A and B.
const fileA = await page.$('#file-a');
const fileB = await page.$('#file-b');
if (!fileA || !fileB) throw new Error('file inputs not found');
await fileA.uploadFile(SOG);
await sleep(4000);
await fileB.uploadFile(SOG);
await sleep(6000);

const afterLoad = await readState();
console.log('AFTER LOAD:', JSON.stringify(afterLoad));

// Set crossfader to 0, sample uniforms + canvas; then 100.
const setCross = (val) => page.evaluate((v) => {
  const cf = document.querySelector('#crossfader');
  cf.value = String(v);
  cf.dispatchEvent(new Event('input', { bubbles: true }));
}, val);

const sampleCanvas = () => page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  // Read a downscaled snapshot via 2d canvas.
  const tmp = document.createElement('canvas');
  tmp.width = 40; tmp.height = 24;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(c, 0, 0, tmp.width, tmp.height);
  const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i+1] + d[i+2];
  return sum;
});

// Sample overlay opacity until it settles after the rebuild (first frames after a
// 2nd-deck load are transient while buffers rebuild).
const settle = async (target, predicate) => {
  await setCross(target);
  let s = null;
  for (let i = 0; i < 16; i++) { await sleep(250); s = await readState(); if (predicate(s)) break; }
  return s;
};

const at0 = await settle(0, s => Math.abs(s.ovB - 0) < 0.05 && Math.abs(s.ovA - 1) < 0.05);
const px0 = await sampleCanvas();
console.log('CROSS=0:', JSON.stringify(at0), 'pxSum=', px0);

const at100 = await settle(100, s => Math.abs(s.ovA - 0) < 0.05 && Math.abs(s.ovB - 1) < 0.05);
const px100 = await sampleCanvas();
console.log('CROSS=100:', JSON.stringify(at100), 'pxSum=', px100);

// Move deck-A pad and deck-B pad, confirm cameras diverge.
const beforePads = await readState();
const padA = await page.$('#hotcue-a-2, .hotcue-a, [data-deck="a"] .pad, #pad-a-1');
// Use preset API to nudge each deck independently (robust to DOM specifics).
await page.evaluate(() => {
  if (window._setDeckCamPreset) {
    window._setDeckCamPreset('a', 1);
    window._setDeckCamPreset('b', 3);
  }
});
await sleep(1200);
const afterPads = await readState();
console.log('CAMS BEFORE:', JSON.stringify({a:beforePads.camA,b:beforePads.camB}));
console.log('CAMS AFTER :', JSON.stringify({a:afterPads.camA,b:afterPads.camB}));

// Unload B (clicking the load button while loaded ejects it).
await page.evaluate(() => {
  const btn = document.querySelector('#btn-load-b');
  if (btn) btn.click();
});
await sleep(2500);
const afterUnload = await readState();
console.log('AFTER UNLOAD B:', JSON.stringify(afterUnload));

console.log('ERRORS:', JSON.stringify(errors));
await browser.close();

// Assertions summary.
const camsDiffer = JSON.stringify(afterPads.camA) !== JSON.stringify(afterPads.camB);
// Crossfade verified via the per-deck overlay opacity telemetry (deck A=1-mix, B=mix).
const opacityChanged = (at0.ovA !== at100.ovA) && (at0.ovB !== at100.ovB);
const pxChanged = (px0 != null && px100 != null && px0 !== px100);
// At cross=0: deck A full (1), deck B off (0). At cross=100: A off (0), B full (1).
const crossWiringOk = (Math.abs(at0.ovA - 1) < 0.05 && Math.abs(at0.ovB - 0) < 0.05 &&
                       Math.abs(at100.ovA - 0) < 0.05 && Math.abs(at100.ovB - 1) < 0.05);
console.log('OVERLAY OPACITY cross0:', at0.ovA, at0.ovB, ' cross100:', at100.ovA, at100.ovB);
console.log('RESULT:', JSON.stringify({ camsDiffer, opacityChanged, crossWiringOk, pxChanged, errorCount: errors.length }));
