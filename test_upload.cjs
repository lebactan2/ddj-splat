const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => {
    if (!msg.text().includes('[vite]')) console.log('PAGE LOG:', msg.text());
  });
  page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  
  const inputUploadHandle = await page.$('#file-a');
  await inputUploadHandle.uploadFile(path.resolve('test_splat.splat'));
  
  console.log('File uploaded. Waiting 2 seconds...');
  await new Promise(r => setTimeout(r, 2000));
  
  await page.screenshot({ path: 'screenshot2_after_upload.png' });
  console.log('Screenshot saved.');
  
  await browser.close();
})();
