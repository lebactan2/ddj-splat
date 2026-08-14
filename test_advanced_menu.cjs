/**
 * ADVANCED dropdown test.
 *
 * The deck-layout toggle, REMOVE BG / SOLID MESH / COLAB checkboxes, the Colab
 * URL field and EXPORT moved off the header strip into a dropdown. They must
 * keep working from inside it, and the menu has to open and close the way a
 * menu should.
 *
 * Requires `npm run dev` on http://localhost:5173.
 */
const puppeteer = require('puppeteer');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MOVED = ['btn-layout-toggle', 'chk-remove-bg', 'chk-solid-mesh',
               'chk-use-colab', 'colab-url', 'btn-export'];

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.toString()));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await wait(500);

  let failures = 0;
  const expect = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' — ' + detail}`);
    if (!cond) failures++;
  };
  const menuShown = () => page.evaluate(() =>
    document.getElementById('advanced-menu').style.display !== 'none');

  // ── every moved control still exists, and lives inside the menu ────────────
  const placement = await page.evaluate((ids) => ids.map((id) => {
    const el = document.getElementById(id);
    return { id, exists: !!el, inMenu: !!el?.closest('#advanced-menu') };
  }), MOVED);
  for (const p of placement) {
    expect(`${p.id} moved into the menu`, p.exists && p.inMenu, JSON.stringify(p));
  }

  // ── closed by default, and hidden means hidden ────────────────────────────
  expect('menu starts closed', (await menuShown()) === false, 'open on load');
  const visibleAtRest = await page.evaluate(() =>
    document.getElementById('chk-solid-mesh').getBoundingClientRect().height > 0);
  expect('its controls are off the header while closed', !visibleAtRest, 'still laid out');

  // ── open ──────────────────────────────────────────────────────────────────
  await page.click('#btn-advanced');
  await wait(150);
  expect('ADVANCED opens the menu', await menuShown(), 'still hidden');
  const label = await page.$eval('#btn-advanced', (el) => el.textContent);
  expect('the button shows its open state', label.includes('▴'), label);

  // The header carries backdrop-filter, which both clips position:fixed children
  // and traps their z-index — the panel was invisible behind the bar until it
  // was re-homed on <body>. Hit-test it rather than trusting the styles.
  const stacking = await page.evaluate(() => {
    const m = document.getElementById('advanced-menu').getBoundingClientRect();
    const hits = [[0.5, 0.1], [0.5, 0.5], [0.5, 0.95]].map(([fx, fy]) =>
      !!document.elementFromPoint(m.left + m.width * fx, m.top + m.height * fy)
        ?.closest('#advanced-menu'));
    return {
      hits,
      onScreen: m.left >= 0 && m.top >= 0
        && m.right <= window.innerWidth && m.bottom <= window.innerHeight,
      parent: document.getElementById('advanced-menu').parentElement.tagName,
    };
  });
  expect('the open panel is the top-most thing at every point inside it',
    stacking.hits.every(Boolean), JSON.stringify(stacking));
  expect('the panel sits fully inside the window', stacking.onScreen, JSON.stringify(stacking));

  // ── controls work from inside, and using them does not close the menu ─────
  // Controls inside the menu are driven with element.click() rather than the
  // mouse: puppeteer scrolls a target into view before a real click, and that
  // scroll moves every following coordinate. The real-mouse behaviour that
  // matters (open, outside-click, Escape) is exercised below.
  const before = await page.$eval('#chk-solid-mesh', (el) => el.checked);
  await page.evaluate(() => document.getElementById('chk-solid-mesh').click());
  await wait(250);
  const after = await page.$eval('#chk-solid-mesh', (el) => el.checked);
  expect('a checkbox toggles from inside the menu', before !== after, `${before} → ${after}`);
  expect('toggling a checkbox leaves the menu open', await menuShown(), 'closed itself');
  await page.evaluate(() => document.getElementById('chk-solid-mesh').click()); // restore
  await wait(250);

  await page.focus('#colab-url');
  await page.keyboard.type('https://example.loca.lt');
  await wait(100);
  expect('the URL field accepts typing',
    (await page.$eval('#colab-url', (el) => el.value)) === 'https://example.loca.lt',
    await page.$eval('#colab-url', (el) => el.value));
  expect('typing leaves the menu open', await menuShown(), 'closed itself');

  const layoutText = await page.$eval('#btn-layout-toggle', (el) => el.textContent);
  await page.evaluate(() => document.getElementById('btn-layout-toggle').click());
  await wait(500);
  const layoutAfter = await page.$eval('#btn-layout-toggle', (el) => el.textContent);
  expect('the layout toggle still switches deck count', layoutText !== layoutAfter,
    `${layoutText} → ${layoutAfter}`);
  await page.evaluate(() => document.getElementById('btn-layout-toggle').click()); // back to 2
  await wait(500);

  // ── close: outside click, then Escape ─────────────────────────────────────
  await page.mouse.click(800, 600);
  await wait(150);
  expect('clicking outside closes it', (await menuShown()) === false, 'still open');

  await page.click('#btn-advanced');
  await wait(150);
  await page.keyboard.press('Escape');
  await wait(150);
  expect('Escape closes it', (await menuShown()) === false, 'still open');

  // ── the header keeps its performance controls ─────────────────────────────
  const headerKept = await page.evaluate(() => ['btn-reset-orient', 'btn-reset',
    'btn-output', 'btn-collapse', 'midi-device'].every((id) => {
    const el = document.getElementById(id);
    return el && !el.closest('#advanced-menu') && el.getBoundingClientRect().height > 0;
  }));
  expect('RESET VIEW / RESET / OUTPUT / HIDE UI / MIDI stay on the header',
    headerKept, 'something went missing');

  expect('no uncaught page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
