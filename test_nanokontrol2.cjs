/**
 * KORG nanoKONTROL2 profile test.
 *
 * Feeds real MIDI bytes through the app's dispatcher (window._simulateMidi)
 * with the nanoKONTROL2 profile selected, and checks the control it is supposed
 * to move actually moved. Every nanoKONTROL2 control is a CC on channel 1, so
 * each message is [0xB0, cc, value].
 *
 * Requires `npm run dev` on http://localhost:5173.
 */
const puppeteer = require('puppeteer');
const path = require('path');

const MODELS = path.resolve(__dirname, '../sample-models');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Sliders are smoothed and their 'change' is debounced, so send a control a few
// times and give the debounce a moment before reading the DOM back.
async function sendCC(page, cc, value, repeats = 6) {
  await page.evaluate((cc, value, repeats) => {
    for (let i = 0; i < repeats; i++) window._simulateMidi([0xb0, cc, value]);
  }, cc, value, repeats);
  await wait(260);
}

const valueOf = (page, id) => page.evaluate((id) => {
  const el = document.getElementById(id);
  return el ? Number(el.value) : null;
}, id);

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.toString()));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });

  let failures = 0;
  const expect = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' — ' + detail}`);
    if (!cond) failures++;
  };

  // The profile must be selectable from the UI dropdown.
  const inDropdown = await page.$eval('#midi-device', (el) =>
    Array.from(el.options).some((o) => o.value === 'nanokontrol2'));
  expect('profile is offered in the MIDI dropdown', inDropdown, 'option missing');

  await page.select('#midi-device', 'nanokontrol2');
  await wait(300);

  // A deck must be loaded for the transport/FX buttons to do anything.
  await (await page.$('#file-a')).uploadFile(path.join(MODELS, 'Duck.glb'));
  await page.waitForFunction(() => /Scene A loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await (await page.$('#file-b')).uploadFile(path.join(MODELS, 'cow.obj'));
  await page.waitForFunction(() => /Scene B loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await wait(500);

  // ── continuous controls: sliders 1-8 (CC 0-7) and knobs 1-8 (CC 16-23) ─────
  const faders = [
    [0, 'vol-a'], [1, 'vol-b'], [2, 'crossfader'], [3, 'master-vol'],
    [4, 'fx-depth-a'], [5, 'fx-depth-b'], [6, 'fx-depth-m'], [7, 'tempo-a'],
    [16, 'eq-hi-a'], [17, 'eq-mid-a'], [18, 'eq-low-a'], [19, 'filter-a'],
    [20, 'eq-hi-b'], [21, 'eq-mid-b'], [22, 'eq-low-b'], [23, 'filter-b'],
  ];
  for (const [cc, id] of faders) {
    const before = await valueOf(page, id);
    await sendCC(page, cc, 127);
    const high = await valueOf(page, id);
    await sendCC(page, cc, 0);
    const low = await valueOf(page, id);
    const el = await page.evaluate((id) => {
      const e = document.getElementById(id);
      return { min: Number(e.min), max: Number(e.max) };
    }, id);
    expect(`CC ${cc} → ${id}`,
      high === el.max && low === el.min,
      `before ${before}, at 127 → ${high} (max ${el.max}), at 0 → ${low} (min ${el.min})`);
    // Leave it centred so later cases start from a sane state.
    await sendCC(page, cc, 64);
  }

  // ── buttons: each must fire the click its target listens for ──────────────
  const buttons = [
    [32, 'btn-play-a'], [33, 'btn-stop-a'], [34, 'sync-a'], [35, 'btn-fx-toggle-a'],
    [36, 'btn-play-b'], [37, 'btn-stop-b'], [38, 'sync-b'], [39, 'btn-fx-toggle-b'],
    [48, 'loop-in-a'], [49, 'loop-out-a'], [50, 'loop-active-a'], [51, 'loop-half-a'],
    [52, 'loop-in-b'], [53, 'loop-out-b'], [54, 'loop-active-b'], [55, 'loop-half-b'],
    [41, 'btn-play-a'], [42, 'btn-stop-a'], [43, 'btn-beat-prev-m'], [44, 'btn-beat-next-m'],
    [45, 'btn-fx-toggle-m'], [46, 'btn-reset-orient'],
    [61, 'loop-double-a'], [62, 'loop-double-b'],
  ];
  for (const [cc, id] of buttons) {
    const clicked = await page.evaluate((id, cc) => new Promise((resolve) => {
      const el = document.getElementById(id);
      if (!el) return resolve('missing element');
      const onClick = () => { el.removeEventListener('click', onClick); resolve(true); };
      el.addEventListener('click', onClick);
      window._simulateMidi([0xb0, cc, 127]);
      window._simulateMidi([0xb0, cc, 0]);
      setTimeout(() => { el.removeEventListener('click', onClick); resolve(false); }, 400);
    }), id, cc);
    expect(`CC ${cc} → clicks ${id}`, clicked === true, String(clicked));
    await wait(120);
  }

  // ── selects: track/marker buttons step the FX dropdowns ───────────────────
  for (const [cc, id] of [[58, 'fx-select-a'], [59, 'fx-select-b'], [60, 'fx-select-m']]) {
    const before = await page.$eval('#' + id, (el) => el.selectedIndex);
    await page.evaluate((cc) => window._simulateMidi([0xb0, cc, 127]), cc);
    await wait(250);
    const after = await page.$eval('#' + id, (el) => el.selectedIndex);
    expect(`CC ${cc} → steps ${id}`, after !== before, `stayed at ${before}`);
    await wait(150);
  }

  // ── pads: REC row triggers hot cues on both decks ─────────────────────────
  const padHits = await page.evaluate(async () => {
    const seen = [];
    const prev = window._handleDeckPad;
    window._handleDeckPad = (deck, index, velocity) => {
      if (velocity > 0) seen.push(`${deck}${index}`);
      if (prev) prev(deck, index, velocity);
    };
    for (const cc of [64, 65, 66, 67, 68, 69, 70, 71]) {
      window._simulateMidi([0xb0, cc, 127]);
      window._simulateMidi([0xb0, cc, 0]);
    }
    await new Promise((r) => setTimeout(r, 200));
    window._handleDeckPad = prev;
    return seen;
  });
  console.log('  pad hits:', JSON.stringify(padHits));
  expect('REC row triggers pads 1-4 on both decks',
    JSON.stringify(padHits) === JSON.stringify(['a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'b3']),
    JSON.stringify(padHits));

  // ── nothing on another MIDI channel may leak through ──────────────────────
  await sendCC(page, 0, 127);
  const railed = await valueOf(page, 'vol-a');
  await page.evaluate(() => {
    for (let i = 0; i < 6; i++) window._simulateMidi([0xb1, 0, 0]); // channel 2
  });
  await wait(260);
  expect('messages on other channels are ignored',
    (await valueOf(page, 'vol-a')) === railed, 'vol-a moved on channel 2');

  expect('no uncaught page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
