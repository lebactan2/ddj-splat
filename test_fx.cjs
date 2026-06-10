const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  console.log("Launching browser...");
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => {
    console.log('PAGE LOG:', msg.text());
  });

  page.on('pageerror', err => {
    console.log('PAGE ERROR:', err.toString());
  });

  console.log("Navigating to http://localhost:5173/...");
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });

  console.log("Uploading test_splat.splat...");
  const fileInput = await page.$('#file-a');
  await fileInput.uploadFile(path.resolve('test_splat.splat'));

  console.log("Waiting 2s...");
  await new Promise(r => setTimeout(r, 2000));

  let statusText = await page.evaluate(() => document.querySelector('#status').textContent);
  console.log("Status after upload:", statusText);

  console.log("Clicking randomize...");
  await page.click('#btn-randomize');
  await new Promise(r => setTimeout(r, 2000));
  statusText = await page.evaluate(() => document.querySelector('#status').textContent);
  console.log("Status after randomize:", statusText);

  console.log("Clicking Delay FX button...");
  await page.click('#btn-delay');

  console.log("Waiting 3 seconds to see if status updates...");
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    statusText = await page.evaluate(() => document.querySelector('#status').textContent);
    console.log(`Status tick ${i}:`, statusText);
  }

  await browser.close();
})();
