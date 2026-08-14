/**
 * MandićLab DJC-DIY profile test.
 *
 * Feeds real MIDI bytes through the app's dispatcher (window._simulateMidi) with
 * the DJC-DIY profile selected, and checks the control it is supposed to move
 * actually moved. The whole device sits on MIDI channel 1, so notes are
 * [0x90/0x80, note, vel] and pots/encoders are [0xB0, cc, value].
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
    Array.from(el.options).some((o) => o.value === 'djc-diy'));
  expect('profile is offered in the MIDI dropdown', inDropdown, 'option missing');

  await page.select('#midi-device', 'djc-diy');
  await wait(300);

  // A deck must be loaded for the transport buttons to do anything. Deck B is
  // loaded FIRST and its pads are exercised while it is the only loaded deck —
  // the loop guard used to test deck A's scene for both decks, which left B's
  // pads dead in exactly this state.
  await (await page.$('#file-b')).uploadFile(path.join(MODELS, 'cow.obj'));
  await page.waitForFunction(() => /Scene B loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await wait(500);

  for (const [note, index, len] of [[0x41, 1, 1], [0x3e, 2, 3]]) {
    const loop = await page.evaluate(async (n) => {
      window._simulateMidi([0x90, n, 127]);
      await new Promise((r) => setTimeout(r, 150));
      const s = window.__loopDebug().b;
      window._simulateMidi([0x80, n, 0]);
      return s;
    }, note);
    expect(`note 0x${note.toString(16)} → deck B pad ${index} loops with only B loaded`,
      loop.active === true && loop.length === len, JSON.stringify(loop));
  }

  // …and the render pipeline itself must run for a deck-B-only session: the
  // animation loop's only route into it used to bail unless deck A was loaded.
  await page.click('#btn-play-b');
  const rtu0 = await page.evaluate(() => window.__rtuCount || 0);
  await wait(1200);
  const rtu1 = await page.evaluate(() => window.__rtuCount || 0);
  expect('realtime updates run with only deck B loaded', rtu1 - rtu0 > 10,
    `${rtu1 - rtu0} updates in 1.2s`);
  await page.click('#btn-play-b'); // back to stopped

  await (await page.$('#file-a')).uploadFile(path.join(MODELS, 'Duck.glb'));
  await page.waitForFunction(() => /Scene A loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await wait(500);

  // ── pots ──────────────────────────────────────────────────────────────────
  // The Mixxx map declares <invert/> on both tempo faders and the crossfader, so
  // those three land on the slider's MIN at MIDI 127.
  const pots = [
    [0x0e, 'tempo-a', true],
    [0x10, 'tempo-b', true],
    [0x0f, 'crossfader', true],
    [0x0d, 'eq-low-a', false],
    [0x0b, 'eq-low-b', false],
    [0x0c, 'filter-a', false],
    [0x0a, 'filter-b', false],
  ];
  for (const [cc, id, inverted] of pots) {
    await sendCC(page, cc, 127);
    const high = await valueOf(page, id);
    await sendCC(page, cc, 0);
    const low = await valueOf(page, id);
    const el = await page.evaluate((id) => {
      const e = document.getElementById(id);
      return { min: Number(e.min), max: Number(e.max) };
    }, id);
    const [at127, at0] = inverted ? [el.min, el.max] : [el.max, el.min];
    expect(`CC 0x${cc.toString(16)} → ${id}${inverted ? ' (inverted)' : ''}`,
      high === at127 && low === at0,
      `at 127 → ${high} (want ${at127}), at 0 → ${low} (want ${at0})`);
    await sendCC(page, cc, 64);
  }

  // ── buttons: each must fire the click its target listens for ──────────────
  const buttons = [
    [0x43, 'btn-play-a'], [0x42, 'btn-stop-a'],
    [0x3f, 'btn-play-b'], [0x40, 'btn-stop-b'],
  ];
  for (const [note, id] of buttons) {
    const clicked = await page.evaluate((id, note) => new Promise((resolve) => {
      const el = document.getElementById(id);
      if (!el) return resolve('missing element');
      const onClick = () => { el.removeEventListener('click', onClick); resolve(true); };
      el.addEventListener('click', onClick);
      window._simulateMidi([0x90, note, 127]);
      window._simulateMidi([0x80, note, 0]);
      setTimeout(() => { el.removeEventListener('click', onClick); resolve(false); }, 400);
    }), id, note);
    expect(`note 0x${note.toString(16)} → clicks ${id}`, clicked === true, String(clicked));
    await wait(120);
  }

  // ── pads: two per deck, in the panel order the Mixxx map declares ─────────
  const padHits = await page.evaluate(async () => {
    const seen = [];
    const prev = window._handleDeckPad;
    window._handleDeckPad = (deck, index, velocity) => {
      if (velocity > 0) seen.push(`${deck}${index}`);
      if (prev) prev(deck, index, velocity);
    };
    for (const note of [0x3c, 0x3d, 0x41, 0x3e]) {
      window._simulateMidi([0x90, note, 127]);
      window._simulateMidi([0x80, note, 0]);
    }
    await new Promise((r) => setTimeout(r, 200));
    window._handleDeckPad = prev;
    return seen;
  });
  console.log('  pad hits:', JSON.stringify(padHits));
  expect('perf pads trigger pads 1-2 on both decks',
    JSON.stringify(padHits) === JSON.stringify(['a0', 'a1', 'b0', 'b1']),
    JSON.stringify(padHits));

  // ── jog wheels: relative encoder, 0x41 forward / 0x3F back ────────────────
  for (const [cc, id] of [[0x14, 'jog-a'], [0x15, 'jog-b']]) {
    const spins = await page.evaluate(async (cc, id) => {
      const el = document.getElementById(id);
      if (!el) return 'missing element';
      const deltas = [];
      const onSpin = (e) => deltas.push(e.detail.delta);
      el.addEventListener('jogspin', onSpin);
      window._simulateMidi([0xb0, cc, 0x41]); // forward
      window._simulateMidi([0xb0, cc, 0x3f]); // back
      await new Promise((r) => setTimeout(r, 200));
      el.removeEventListener('jogspin', onSpin);
      return deltas;
    }, cc, id);
    // One detent edge = one step of 0.15 rad; 0x41 and 0x3F must be opposites
    // and must NOT be decoded as a ~63-tick jump (see spinJogOffset64).
    expect(`CC 0x${cc.toString(16)} → spins ${id} one step each way`,
      Array.isArray(spins) && spins.length === 2
        && spins[0] === -0.15 && spins[1] === 0.15,
      JSON.stringify(spins));
  }

  // ── re-mapping a jog through MIDI MAP must keep the encoder decode ────────
  // The generic 'jog-*' action uses the signed-count decode, which would turn
  // one detent into a ~63-tick sweep on this hardware, so the override layer
  // has to offer the encoder variant.
  const overrideSpin = await page.evaluate(async () => {
    window._mergeProfileOverride('djc-diy', { 'cc:0:20': 'jog-a-encoder' });
    const el = document.getElementById('jog-a');
    const deltas = [];
    const onSpin = (e) => deltas.push(e.detail.delta);
    el.addEventListener('jogspin', onSpin);
    window._simulateMidi([0xb0, 0x14, 0x41]);
    window._simulateMidi([0xb0, 0x14, 0x3f]);
    await new Promise((r) => setTimeout(r, 200));
    el.removeEventListener('jogspin', onSpin);
    window._clearProfileOverride('djc-diy');
    return deltas;
  });
  expect('jog re-mapped via MIDI MAP keeps the one-detent decode',
    JSON.stringify(overrideSpin) === JSON.stringify([-0.15, 0.15]),
    JSON.stringify(overrideSpin));

  // ── nothing on another MIDI channel may leak through ──────────────────────
  await sendCC(page, 0x0d, 127);
  const railed = await valueOf(page, 'eq-low-a');
  await page.evaluate(() => {
    for (let i = 0; i < 6; i++) window._simulateMidi([0xb1, 0x0d, 0]); // channel 2
  });
  await wait(260);
  expect('messages on other channels are ignored',
    (await valueOf(page, 'eq-low-a')) === railed, 'eq-low-a moved on channel 2');

  expect('no uncaught page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
