/**
 * Audio FFT / auto-VJ test.
 *
 * The FILE source is what gets exercised end to end, with test_tone.wav — a
 * generated 5s clip carrying a 60Hz kick, a 440Hz body tone and 6kHz hats, so
 * all three bands read something. (Chrome's fake capture device is silent, so a
 * mic-based test can only prove the capture starts, not that analysis works.)
 *
 * Chain under test: file → analyser → bands → auto-VJ routing → hydra uniforms,
 * with the knobs left exactly where the user put them.
 *
 * Requires `npm run dev` on http://localhost:5173.
 */
const puppeteer = require('puppeteer');
const path = require('path');

const MODELS = path.resolve(__dirname, '../sample-models');
const TONE = path.resolve(__dirname, 'test_tone.wav');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  await browser.defaultBrowserContext().overridePermissions('http://localhost:5173', ['microphone']);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.toString()));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await wait(600);

  let failures = 0;
  const expect = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' — ' + detail}`);
    if (!cond) failures++;
  };
  const st = () => page.evaluate(() => window._audioState());

  // ── button + panel ────────────────────────────────────────────────────────
  const inBar = await page.evaluate(() => {
    const b = document.getElementById('btn-audio');
    return !!b && b.getBoundingClientRect().height > 0 && !b.closest('#advanced-menu');
  });
  expect('AUDIO button is in the top bar', inBar, 'missing or hidden');
  expect('the panel starts closed',
    (await page.evaluate(() => document.getElementById('audio-panel').style.display)) === 'none', 'open');

  await page.click('#btn-audio');
  await wait(250);
  const opened = await page.evaluate(() => {
    const p = document.getElementById('audio-panel');
    const r = p.getBoundingClientRect();
    return {
      shown: p.style.display !== 'none',
      onTop: !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#audio-panel'),
      onScreen: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    };
  });
  expect('AUDIO opens a panel that sits above the bar',
    opened.shown && opened.onTop && opened.onScreen, JSON.stringify(opened));

  // The hydra pass only exists once a viewer does, so load a deck first.
  await (await page.$('#file-a')).uploadFile(path.join(MODELS, 'Duck.glb'));
  await page.waitForFunction(() => /Scene A loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await wait(1200);

  // ── file source: the whole chain ──────────────────────────────────────────
  await (await page.$('#audio-file-input')).uploadFile(TONE);
  await page.waitForFunction(() => window._audioState().on === true, { timeout: 20000 });
  await wait(1500);

  const lv = await st();
  expect('the file source starts analysing', lv.on && lv.source === 'file', JSON.stringify(lv));
  expect('all three bands read energy from the tone',
    lv.low > 0.01 && lv.mid > 0.01 && lv.high > 0.005,
    `low=${lv.low.toFixed(3)} mid=${lv.mid.toFixed(3)} high=${lv.high.toFixed(3)}`);

  const driving = await page.evaluate(() => ({
    mod: window._audioState().mod,
    passOn: window._hydraPassEnabled(),
    knobs: window._hydraAmounts(),
    knobEls: ['kaleid', 'modulate', 'colorama', 'pixel', 'thresh']
      .map((n) => Number(document.getElementById(`hydra-${n}`).value)),
  }));
  expect('auto VJ modulates the hydra bank',
    Object.keys(driving.mod).length > 0 && driving.passOn === true, JSON.stringify(driving));
  expect('the routed ops are the ones that move',
    ['modulate', 'colorama', 'pixel'].some((op) => (driving.mod[op] || 0) > 0.01), JSON.stringify(driving.mod));
  expect('it leaves the knobs where the user put them',
    Object.values(driving.knobs).every((v) => v === 0) && driving.knobEls.every((v) => v === 0),
    JSON.stringify(driving));

  // ── the frame really changes with the music ───────────────────────────────
  const shot = async () => {
    const box = await page.evaluate(() => {
      const r = document.querySelector('canvas').getBoundingClientRect();
      return { x: r.x + 200, y: r.y + 100, width: 400, height: 300 };
    });
    return page.screenshot({ encoding: 'binary', clip: box });
  };
  const f1 = await shot();
  await wait(700);
  const f2 = await shot();
  expect('the picture moves with the audio', Buffer.compare(f1, f2) !== 0, 'frames identical');

  // ── DEPTH / AUTO gates ────────────────────────────────────────────────────
  await page.evaluate(() => window._setAutoVj(true, 0));
  await wait(400);
  const zero = await page.evaluate(() => ({ mod: window._audioState().mod, passOn: window._hydraPassEnabled() }));
  expect('DEPTH at zero stops the modulation',
    Object.keys(zero.mod).length === 0 && zero.passOn === false, JSON.stringify(zero));

  await page.evaluate(() => window._setAutoVj(false, 0.6));
  await wait(400);
  const off = await page.evaluate(() => ({ mod: window._audioState().mod, passOn: window._hydraPassEnabled() }));
  expect('AUTO off stops the modulation too',
    Object.keys(off.mod).length === 0 && off.passOn === false, JSON.stringify(off));

  // A hand-set knob still works while the analyser runs.
  await page.evaluate(() => {
    const el = document.getElementById('hydra-posterize');
    el.value = '70';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(300);
  expect('knobs still work with audio running and AUTO off',
    (await page.evaluate(() => window._hydraPassEnabled())) === true, 'pass stayed off');

  // …and the audio adds to that knob rather than replacing it.
  await page.evaluate(() => window._setAutoVj(true, 0.8));
  await wait(600);
  const both = await page.evaluate(() => ({
    knob: window._hydraAmounts().posterize,
    mod: window._audioState().mod,
  }));
  expect('the knob value survives while audio modulates other ops',
    Math.abs(both.knob - 0.7) < 0.001, JSON.stringify(both));
  await page.evaluate(() => {
    const el = document.getElementById('hydra-posterize');
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // ── mic capture starts (silent under the fake device, so start only) ──────
  await page.click('#audio-src-mic');
  await page.waitForFunction(() => window._audioState().source === 'mic', { timeout: 20000 });
  expect('the mic source starts', (await st()).on === true, JSON.stringify(await st()));

  // ── OFF tears it down ─────────────────────────────────────────────────────
  await page.click('#audio-src-off');
  await wait(500);
  const stopped = await st();
  const passAfter = await page.evaluate(() => window._hydraPassEnabled());
  expect('OFF stops the analyser and clears the modulation',
    stopped.on === false && stopped.source === 'none'
      && Object.keys(stopped.mod).length === 0 && passAfter === false, JSON.stringify(stopped));

  expect('no uncaught page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
