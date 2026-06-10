const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  console.log("Launching browser...");
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  // Set window size
  await page.setViewport({ width: 1280, height: 720 });

  page.on('console', msg => {
    const text = msg.text();
    if (!text.includes('[vite]')) {
      console.log('PAGE LOG:', text);
    }
  });

  page.on('pageerror', err => {
    console.log('PAGE ERROR:', err.toString());
  });

  console.log("Navigating to http://localhost:5173/...");
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 30000 });

  // 1. Upload Scene A (Tree.ply)
  console.log("Uploading Scene A...");
  const fileAInput = await page.$('#file-a');
  await fileAInput.uploadFile('C:/Cut up splatting/Splats/tree-scaniverse-3d-gaussian-splat-ply/source/Tree/Tree.ply');
  
  // Wait for loading to complete (we can check the status text)
  console.log("Waiting for Scene A to load...");
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#status').textContent;
      return status.includes('Scene A loaded') || status.toLowerCase().includes('error');
    },
    { timeout: 30000 }
  );

  let statusText = await page.evaluate(() => document.querySelector('#status').textContent);
  console.log("Scene A Load Status:", statusText);

  // Take screenshot of Scene A
  await page.screenshot({ path: 'screenshot_scene_a.png' });
  console.log("Saved screenshot_scene_a.png");

  // 2. Upload Scene B (Pipework.ply)
  console.log("Uploading Scene B...");
  const fileBInput = await page.$('#file-b');
  await fileBInput.uploadFile('C:/Cut up splatting/Splats/pipework-scaniverse-3d-gaussian-splat-ply/source/Scaniverse 2024-03-31 180002 - Cloud.extract.ply');

  console.log("Waiting for Scene B to load...");
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#status').textContent;
      return status.includes('Scene B loaded') || status.toLowerCase().includes('error');
    },
    { timeout: 30000 }
  );

  statusText = await page.evaluate(() => document.querySelector('#status').textContent);
  console.log("Scene B Load Status:", statusText);

  // 3. Randomize (Collage of A and B)
  console.log("Clicking Randomize button...");
  await page.click('#btn-randomize');

  console.log("Waiting for collage to generate and render...");
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#status').textContent;
      return status.includes('Collage ready') || status.toLowerCase().includes('error');
    },
    { timeout: 30000 }
  );

  statusText = await page.evaluate(() => document.querySelector('#status').textContent);
  console.log("Collage Status:", statusText);

  // Take screenshot of Collage
  await page.screenshot({ path: 'screenshot_collage.png' });
  console.log("Saved screenshot_collage.png");

  // 4. Test DJ FX: Engage Delay FX
  console.log("Engaging Delay FX...");
  await page.click('#btn-delay');

  console.log("Waiting for Delay FX to render...");
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#status').textContent;
      return status.includes('Delay') || status.toLowerCase().includes('error');
    },
    { timeout: 15000 }
  );

  statusText = await page.evaluate(() => document.querySelector('#status').textContent);
  console.log("Delay FX Status:", statusText);

  // Take screenshot of Delay FX
  await page.screenshot({ path: 'screenshot_fx_delay.png' });
  console.log("Saved screenshot_fx_delay.png");

  // 5. Test DJ FX: Engage Reverb FX
  console.log("Engaging Reverb FX...");
  await page.click('#btn-reverb');

  console.log("Waiting for Reverb FX to render...");
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#status').textContent;
      return status.includes('Reverb') || status.toLowerCase().includes('error');
    },
    { timeout: 15000 }
  );

  statusText = await page.evaluate(() => document.querySelector('#status').textContent);
  console.log("Reverb FX Status:", statusText);

  // Take screenshot of Reverb FX
  await page.screenshot({ path: 'screenshot_fx_reverb.png' });
  console.log("Saved screenshot_fx_reverb.png");

  // 6. Test DJ FX: Engage Filter FX
  console.log("Engaging Filter FX...");
  await page.click('#btn-filter');

  console.log("Waiting for Filter FX to render...");
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#status').textContent;
      return status.includes('Filter') || status.toLowerCase().includes('error');
    },
    { timeout: 15000 }
  );

  statusText = await page.evaluate(() => document.querySelector('#status').textContent);
  console.log("Filter FX Status:", statusText);

  // Take screenshot of Filter FX
  await page.screenshot({ path: 'screenshot_fx_filter.png' });
  console.log("Saved screenshot_fx_filter.png");

  console.log("Testing complete.");
  await browser.close();
})();
