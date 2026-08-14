/**
 * FX-switching regression test.
 *
 * roll and spiral add chunks to a deck, so the chunk counts run ahead of the
 * viewer's scene list for a frame or two after a switch. Deck B's transform loop
 * lacked the bounds check decks A/C/D have, and getSplatScene() THROWS on an
 * out-of-range index — every switch aborted that frame's realtime update with
 * "SplatMesh::getScene() -> Invalid scene index".
 *
 * Requires `npm run dev` on http://localhost:5173.
 */
const puppeteer = require('puppeteer');
const path = require('path');

const MODELS = path.resolve(__dirname, '../sample-models');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FX = ['roll', 'spiral', 'reverb', 'filter', 'flanger', 'phaser', 'delay', 'echo', 'none'];

const pickFx = (page, deck, fx) => page.evaluate((deck, fx) => {
  const s = document.getElementById(`fx-select-${deck}`);
  if (!s || ![...s.options].some((o) => o.value === fx)) return false;
  s.value = fx;
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, deck, fx);

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.toString()));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await wait(500);

  let failures = 0;
  const expect = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' — ' + detail}`);
    if (!cond) failures++;
  };
  // Headless has no Web MIDI; that one error is expected and not what we test.
  const realErrors = () => errors.filter((e) => !/Could not access MIDI/.test(e));

  await (await page.$('#file-a')).uploadFile(path.join(MODELS, 'Duck.glb'));
  await page.waitForFunction(() => /Scene A loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await (await page.$('#file-b')).uploadFile(path.join(MODELS, 'cow.obj'));
  await page.waitForFunction(() => /Scene B loaded/.test(document.querySelector('#status').textContent), { timeout: 180000 });
  await wait(1500);
  await page.evaluate(() => {
    document.getElementById('btn-play-a').click();
    document.getElementById('btn-play-b').click();
  });
  await wait(800);

  // Each deck in turn, engaged, cycling through the whole FX list.
  for (const deck of ['a', 'b']) {
    await page.evaluate((d) => document.getElementById(`btn-fx-toggle-${d}`)?.click(), deck);
    await wait(400);
    const mark = realErrors().length;
    for (const fx of FX) {
      await pickFx(page, deck, fx);
      await wait(350);
    }
    const added = realErrors().slice(mark);
    expect(`deck ${deck.toUpperCase()}: cycling every FX raises no errors`,
      added.length === 0, added.join(' | '));
    await page.evaluate((d) => document.getElementById(`btn-fx-toggle-${d}`)?.click(), deck);
    await wait(300);
  }

  // Both decks on a chunk-adding FX at once, then straight back off.
  const mark = realErrors().length;
  await pickFx(page, 'a', 'spiral');
  await pickFx(page, 'b', 'roll');
  await page.evaluate(() => {
    document.getElementById('btn-fx-toggle-a')?.click();
    document.getElementById('btn-fx-toggle-b')?.click();
  });
  await wait(1200);
  await page.evaluate(() => {
    document.getElementById('btn-fx-toggle-a')?.click();
    document.getElementById('btn-fx-toggle-b')?.click();
  });
  await wait(800);
  expect('both decks on chunk-adding FX at once raises no errors',
    realErrors().slice(mark).length === 0, realErrors().slice(mark).join(' | '));

  // The pipeline must still be running after all that.
  const rtu = await page.evaluate(async () => {
    const a = window.__rtuCount || 0;
    await new Promise((r) => setTimeout(r, 800));
    return (window.__rtuCount || 0) - a;
  });
  expect('the realtime pipeline is still running afterwards', rtu > 5, `${rtu} updates in 0.8s`);

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
