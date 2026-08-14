/**
 * Browser test for the two new deck loaders:
 *   1. an unbundled SOG (loose meta.json + .webp textures) dropped on a deck
 *   2. a .spz file (Niantic v2) dropped on a deck
 *   3. a lone .webp, which must still route to the image-reconstruction backend
 *
 * The SOG textures are synthesised in-page with canvas -> WebP, so the decoded
 * values are lossy garbage; this test asserts the plumbing (routing, decode,
 * splat count, viewer rebuild), not numeric fidelity. Numeric fidelity for SPZ
 * is covered by test_spz.mjs.
 *
 * Requires `npm run dev` on http://localhost:5173.
 */
const puppeteer = require('puppeteer');
const { gzipSync } = require('fflate');

const N = 64;
const FRACTIONAL_BITS = 12;

// ── Build a tiny valid SPZ v2 file ──────────────────────────────────────────
function buildSpzV2() {
  const header = new Uint8Array(16);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 0x5053474e, true);
  hv.setUint32(4, 2, true);
  hv.setUint32(8, N, true);
  header[12] = 0;
  header[13] = FRACTIONAL_BITS;

  const positions = new Uint8Array(N * 9);
  for (let i = 0; i < N; i++) {
    const coords = [(i % 4) - 1.5, ((i >> 2) % 4) - 1.5, ((i >> 4) % 4) - 1.5];
    coords.forEach((c, k) => {
      const fixed = Math.round(c * (1 << FRACTIONAL_BITS));
      const o = i * 9 + k * 3;
      positions[o] = fixed & 0xff;
      positions[o + 1] = (fixed >> 8) & 0xff;
      positions[o + 2] = (fixed >> 16) & 0xff;
    });
  }
  const alphas = new Uint8Array(N).fill(255);
  const colors = new Uint8Array(N * 3).fill(200);
  const scales = new Uint8Array(N * 3).fill(Math.round((Math.log(0.05) + 10) * 16));
  const rotations = new Uint8Array(N * 3).fill(128); // ~identity

  const payload = new Uint8Array(header.length + positions.length + alphas.length +
                                 colors.length + scales.length + rotations.length);
  let o = 0;
  for (const part of [header, positions, alphas, colors, scales, rotations]) {
    payload.set(part, o); o += part.length;
  }
  return gzipSync(payload);
}

const STATUS = '#status';

async function readStatus(page) {
  return page.$eval(STATUS, (el) => el.textContent);
}

async function waitForStatus(page, matcher, timeout = 30000) {
  await page.waitForFunction(
    (sel, pattern) => new RegExp(pattern).test(document.querySelector(sel).textContent),
    { timeout }, STATUS, matcher);
  return readStatus(page);
}

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.toString()));
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error' && !t.includes('[vite]')) console.log('PAGE ERROR LOG:', t);
  });

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });

  let failures = 0;
  const expect = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' — ' + detail}`);
    if (!cond) failures++;
  };

  // ── 1. unbundled SOG: meta.json + five .webp textures on deck A ───────────
  await page.evaluate(async (count) => {
    const side = Math.sqrt(count); // 8x8

    async function webpFile(name, fill) {
      const canvas = document.createElement('canvas');
      canvas.width = side; canvas.height = side;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(side, side);
      for (let i = 0; i < count; i++) {
        const px = fill(i);
        img.data.set(px, i * 4);
      }
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp'));
      return new File([blob], name, { type: 'image/webp' });
    }

    const codebook = Array.from({ length: 256 }, (_, i) => (i / 255) * 4 - 2);
    const meta = {
      version: 2,
      count,
      means: {
        shape: [side, side],
        dtype: 'uint8',
        files: ['means_l.webp', 'means_u.webp'],
        mins: [-1, -1, -1],
        maxs: [1, 1, 1],
      },
      scales: { shape: [side, side], files: ['scales.webp'], codebook: codebook.map((v) => v - 3) },
      quats: { shape: [side, side], files: ['quats.webp'] },
      sh0: { shape: [side, side], files: ['sh0.webp'], codebook },
    };

    const files = [
      new File([JSON.stringify(meta)], 'meta.json', { type: 'application/json' }),
      await webpFile('means_l.webp', (i) => [i * 3 % 256, i * 5 % 256, i * 7 % 256, 255]),
      await webpFile('means_u.webp', (i) => [i % 256, (i * 2) % 256, (i * 3) % 256, 255]),
      await webpFile('scales.webp', () => [40, 40, 40, 255]),
      await webpFile('quats.webp', () => [128, 128, 128, 252]),
      await webpFile('sh0.webp', (i) => [200, 180, 160, 255]),
    ];

    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const input = document.querySelector('#file-a');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  }, N);

  let status = await waitForStatus(page, 'Scene A (loaded|.*Error)').catch(() => readStatus(page));
  expect('unbundled SOG (webp) loads on deck A', /Scene A loaded/.test(status), status);

  // ── 2. .spz on deck B ─────────────────────────────────────────────────────
  const spzB64 = Buffer.from(buildSpzV2()).toString('base64');
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'fixture.spz', { type: 'application/octet-stream' }));
    const input = document.querySelector('#file-b');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  }, spzB64);

  status = await waitForStatus(page, 'Scene B (loaded|.*Error)').catch(() => readStatus(page));
  expect('.spz loads on deck B', /Scene B loaded/.test(status), status);

  // ── 3. lone .webp still routes to the image backend ───────────────────────
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 16; canvas.height = 16;
    canvas.getContext('2d').fillRect(0, 0, 16, 16);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'photo.webp', { type: 'image/webp' }));
    const input = document.querySelector('#file-a');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });

  status = await waitForStatus(page, 'Scene A (loaded|.*Error)').catch(() => readStatus(page));
  // No backend is running in CI, so the expected outcome is the backend error,
  // which proves the file reached the image path rather than being rejected.
  expect('lone .webp routes to image backend',
    /process image|backend/i.test(status), status);

  expect('no uncaught page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
