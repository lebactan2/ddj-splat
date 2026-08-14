/**
 * Deck-panel fit test (2-deck layout).
 *
 * The deck panels used to stop at 50% of the window height even in 2-deck mode,
 * where the bottom half is empty, so the second row of pads was clipped on
 * anything shorter than ~750px. All eight pads must be inside the panel at every
 * size we care about.
 *
 * Requires `npm run dev` on http://localhost:5173.
 */
const puppeteer = require('puppeteer');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZES = [[1920, 1080], [1600, 950], [1440, 900], [1366, 768], [1280, 720], [1280, 660]];

const measure = (page) => page.evaluate(() => {
  const decks = [...document.querySelectorAll('.hud-panel')]
    .filter((p) => p.querySelector('.pads-grid') && p.getBoundingClientRect().height > 0);
  return decks.map((panel) => {
    const pb = panel.getBoundingClientRect();
    const pads = [...panel.querySelectorAll('.pad-btn')];
    const inside = pads.filter((p) => {
      const b = p.getBoundingClientRect();
      return b.height > 0 && b.top >= pb.top - 0.5 && b.bottom <= pb.bottom + 0.5
        && b.bottom <= window.innerHeight;
    }).length;
    const grid = panel.querySelector('.pads-grid').getBoundingClientRect();
    return {
      deck: panel.id,
      inside,
      total: pads.length,
      // >0 means the panel is hiding content behind its overflow:hidden.
      clipped: Math.max(0, Math.round(panel.scrollHeight - panel.clientHeight)),
      // The column ends just under the pads — it neither stops short of them
      // nor runs on to the bottom of the window.
      gapUnderPads: Math.round(pb.bottom - grid.bottom),
      slackToFloor: Math.round(window.innerHeight - pb.bottom),
    };
  });
});

(async () => {
  const browser = await puppeteer.launch();
  let failures = 0;
  const expect = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' — ' + detail}`);
    if (!cond) failures++;
  };

  for (const [w, h] of SIZES) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
    await wait(600);

    const decks = await measure(page);
    expect(`${w}x${h}: both decks are on screen`, decks.length === 2, JSON.stringify(decks));
    for (const d of decks) {
      expect(`${w}x${h}: ${d.deck} shows all ${d.total} pads`,
        d.inside === d.total && d.total === 8, JSON.stringify(d));
      expect(`${w}x${h}: ${d.deck} clips nothing`, d.clipped === 0, `${d.clipped}px hidden`);
      expect(`${w}x${h}: ${d.deck} ends just under its pads`,
        d.gapUnderPads >= 0 && d.gapUnderPads <= 40, `${d.gapUnderPads}px below the pads`);
    }
    await page.close();
  }

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
