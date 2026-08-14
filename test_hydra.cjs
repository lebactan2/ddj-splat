/**
 * Hydra screen-FX bank test.
 *
 * The bank is a single ShaderPass at the end of the composer, one knob per op.
 * It must stay switched off while every knob is at zero, come alive as soon as
 * one moves, drive the matching uniform, survive a viewer rebuild, and be
 * reachable over MIDI like any other control.
 *
 * Requires `npm run dev` on http://localhost:5173.
 */
const puppeteer = require('puppeteer');
const path = require('path');

const MODELS = path.resolve(__dirname, '../sample-models');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OPS = ['kaleid', 'repeat', 'scroll', 'modulate', 'pixel', 'colorama', 'posterize', 'thresh'];

const setKnob = (page, name, v) => page.evaluate((name, v) => {
  const el = document.getElementById(`hydra-${name}`);
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, name, v);

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.toString()));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await wait(600);

  let failures = 0;
  const expect = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' — ' + detail}`);
    if (!cond) failures++;
  };

  // ── every op has a knob on the master strip ───────────────────────────────
  const present = await page.evaluate((ops) => ops.map((n) => {
    const el = document.getElementById(`hydra-${n}`);
    return { n, exists: !!el, visible: (el?.getBoundingClientRect().height || 0) > 0 };
  }), OPS);
  for (const p of present) {
    expect(`${p.n} knob is on the master strip`, p.exists && p.visible, JSON.stringify(p));
  }

  // A deck has to be loaded for the composer (and the pass) to exist at all.
  await (await page.$('#file-a')).uploadFile(path.join(MODELS, 'Duck.glb'));
  await page.waitForFunction(() => /Scene A loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await wait(1200);

  expect('the pass is off while every knob is at zero',
    (await page.evaluate(() => window._hydraPassEnabled())) === false, 'enabled at rest');

  // ── each knob drives its own amount, and nothing else ─────────────────────
  for (const op of OPS) {
    await setKnob(page, op, 80);
    await wait(80);
    const state = await page.evaluate(() => ({
      amounts: window._hydraAmounts(),
      enabled: window._hydraPassEnabled(),
    }));
    const others = OPS.filter((o) => o !== op).every((o) => state.amounts[o] === 0);
    expect(`${op} knob sets only its own amount`,
      Math.abs(state.amounts[op] - 0.8) < 0.001 && others, JSON.stringify(state.amounts));
    expect(`${op} switches the pass on`, state.enabled === true, 'pass still disabled');
    await setKnob(page, op, 0);
    await wait(80);
  }

  expect('back to zero switches the pass off again',
    (await page.evaluate(() => window._hydraPassEnabled())) === false, 'still enabled');

  // ── the frame actually changes when an op is engaged ──────────────────────
  const shot = async () => {
    const box = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, width: Math.min(r.width, 600), height: Math.min(r.height, 400) };
    });
    return await page.screenshot({ encoding: 'binary', clip: box });
  };
  const before = await shot();
  await setKnob(page, 'kaleid', 90);
  await wait(500);
  const after = await shot();
  expect('engaging kaleid changes the rendered frame',
    Buffer.compare(before, after) !== 0, 'frame identical');
  await setKnob(page, 'kaleid', 0);
  await wait(300);

  // ── amounts survive a viewer rebuild (which throws the composer away) ─────
  await setKnob(page, 'pixel', 60);
  await wait(150);
  await (await page.$('#file-b')).uploadFile(path.join(MODELS, 'cow.obj'));
  await page.waitForFunction(() => /Scene B loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await wait(1200);
  const afterRebuild = await page.evaluate(() => ({
    amount: window._hydraAmounts().pixel,
    enabled: window._hydraPassEnabled(),
  }));
  expect('an engaged op survives loading another deck',
    Math.abs(afterRebuild.amount - 0.6) < 0.001 && afterRebuild.enabled === true,
    JSON.stringify(afterRebuild));
  await setKnob(page, 'pixel', 0);
  await wait(150);

  // ── reachable over MIDI like any other control ────────────────────────────
  await page.select('#midi-device', 'ddj-flx4');
  await wait(200);
  const midiDrove = await page.evaluate(() => {
    window._mergeProfileOverride('ddj-flx4', { 'cc:6:101': 'hydra-thresh' });
    window.dispatchEvent(new CustomEvent('midi-profile-changed'));
    for (let i = 0; i < 8; i++) window._simulateMidi([0xb6, 101, 127]);
    return new Promise((resolve) => setTimeout(() => resolve({
      amount: window._hydraAmounts().thresh,
      enabled: window._hydraPassEnabled(),
      knob: Number(document.getElementById('hydra-thresh').value),
    }), 400));
  });
  expect('a mapped MIDI control drives a hydra op',
    midiDrove.amount > 0.9 && midiDrove.enabled === true && midiDrove.knob > 90,
    JSON.stringify(midiDrove));

  const hint = await page.evaluate(() => {
    const m = window._midiHintMap();
    return m['el:hydra-thresh'] || null;
  });
  expect('the hover hint knows the new binding',
    Array.isArray(hint) && hint.some((b) => b.type === 'cc' && b.data1 === 101), JSON.stringify(hint));

  await page.evaluate(() => {
    window._clearProfileOverride('ddj-flx4');
    window.dispatchEvent(new CustomEvent('midi-profile-changed'));
  });

  expect('no uncaught page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
