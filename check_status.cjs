const puppeteer = require('puppeteer');
const path = require('path');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  const inputUploadHandle = await page.$('#file-a');
  await inputUploadHandle.uploadFile(path.resolve('test_splat.splat'));
  await new Promise(r => setTimeout(r, 2000));
  
  const status = await page.evaluate(() => {
    return {
      running: window.viewer.selfDrivenModeRunning,
      cameraPos: window.viewer.camera.position,
      target: window.viewer.controls.target
    };
  });
  console.log('Status:', status);
  await browser.close();
})();
