/**
 * Hover-hint test.
 *
 * Hovering an on-screen control must name the MIDI control that drives it under
 * the active profile, plus any keyboard key / gamepad button bound to the same
 * action. The MIDI half is derived by sweeping the profile in capture mode, so
 * this also checks that derivation against the numbers in midi.js.
 *
 * Requires `npm run dev` on http://localhost:5173.
 */
const puppeteer = require('puppeteer');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Move the mouse to the centre of a selector and read the hint back. */
async function hoverText(page, selector) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  if (!box) return '(element missing)';
  await page.mouse.move(box.x - 3, box.y - 3);
  await page.mouse.move(box.x, box.y);
  await wait(120);
  return await page.evaluate(() => {
    const el = document.getElementById('midi-hint');
    return el && el.style.display !== 'none' ? el.textContent : '';
  });
}

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.toString()));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await wait(600);

  let failures = 0;
  const expect = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' — ' + detail}`);
    if (!cond) failures++;
  };

  // ── DDJ-FLX4: play A is note 11 on channel 1 ──────────────────────────────
  await page.select('#midi-device', 'ddj-flx4');
  await wait(200);
  let txt = await hoverText(page, '#btn-play-a');
  console.log('  flx4 play A hint:', JSON.stringify(txt));
  expect('hover names the MIDI note for play A',
    txt.includes('CH1') && txt.includes('Note 11'), txt);

  txt = await hoverText(page, '#crossfader');
  console.log('  flx4 crossfader hint:', JSON.stringify(txt));
  expect('hover names the crossfader CC',
    txt.includes('CH7') && txt.includes('CC 31'), txt);

  // ── Keyboard + gamepad hints ride along on the same control ───────────────
  txt = await hoverText(page, '#btn-play-a');
  expect('hover also names the keyboard key', txt.includes('⌨'), txt);
  expect('hover also names the gamepad button', txt.includes('🎮'), txt);

  // ── Pads carry two roles, and the hint labels which is which ──────────────
  txt = await hoverText(page, '#pads-a .pad-btn[data-pad="0"]');
  console.log('  pad 1 hint:', JSON.stringify(txt));
  expect('pad hint names the physical loop pad',
    txt.includes('Loop pad') && txt.includes('Note 0'), txt);

  // ── Switching profile re-derives the numbers ──────────────────────────────
  await page.select('#midi-device', 'djc-diy');
  await wait(300);
  txt = await hoverText(page, '#btn-play-a');
  console.log('  djc-diy play A hint:', JSON.stringify(txt));
  expect('profile switch updates the hint',
    txt.includes('Note 67') && txt.includes('0x43'), txt);

  txt = await hoverText(page, '#jog-a');
  console.log('  djc-diy jog A hint:', JSON.stringify(txt));
  expect('jog hint reads the encoder CC', txt.includes('CC 20'), txt);

  // ── A MIDI MAP override shows up alongside the built-in ───────────────────
  // Adding an override does not disable the factory note: the dispatcher only
  // skips the built-in for the exact message that was re-mapped, so note 0x43
  // still fires play A too. The hint has to report both, not just the new one.
  await page.evaluate(() => {
    window._mergeProfileOverride('djc-diy', { 'note:0:100': 'play-a' });
    window.dispatchEvent(new CustomEvent('midi-profile-changed'));
  });
  await wait(250);
  txt = await hoverText(page, '#btn-play-a');
  console.log('  overridden play A hint:', JSON.stringify(txt));
  expect('override binding joins the built-in one in the hint',
    txt.includes('Note 100') && txt.includes('Note 67'), txt);

  // …and re-mapping a message the built-in already used replaces it outright.
  await page.evaluate(() => {
    window._mergeProfileOverride('djc-diy', { 'note:0:67': 'cue-a' });
    window.dispatchEvent(new CustomEvent('midi-profile-changed'));
  });
  await wait(250);
  txt = await hoverText(page, '#btn-play-a');
  console.log('  re-pointed note 0x43:', JSON.stringify(txt));
  expect('re-mapping a built-in message drops it from the old control',
    !txt.includes('Note 67'), txt);
  txt = await hoverText(page, '#btn-stop-a');
  expect('…and moves it to the new one', txt.includes('Note 67'), txt);
  await page.evaluate(() => {
    window._clearProfileOverride('djc-diy');
    window.dispatchEvent(new CustomEvent('midi-profile-changed'));
  });
  await wait(200);

  // ── Unmapped controls stay quiet ──────────────────────────────────────────
  txt = await hoverText(page, '#fps-counter');
  expect('an unmapped element shows no hint', txt === '', JSON.stringify(txt));

  // ── The hint gets out of the way during a drag ────────────────────────────
  const cf = await page.evaluate(() => {
    const r = document.getElementById('crossfader').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(cf.x, cf.y);
  await wait(120);
  await page.mouse.down();
  await page.mouse.move(cf.x + 30, cf.y);
  await wait(120);
  const duringDrag = await page.evaluate(() => document.getElementById('midi-hint').style.display);
  await page.mouse.up();
  expect('hint hides while dragging a control', duringDrag === 'none', duringDrag);

  expect('no uncaught page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
