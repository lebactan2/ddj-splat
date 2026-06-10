const puppeteer = require('puppeteer');
const path = require('path');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  const inputUploadHandle = await page.$('#file-a');
  await inputUploadHandle.uploadFile(path.resolve('test_splat.splat'));
  await new Promise(r => setTimeout(r, 2000));
  
  const viewerInfo = await page.evaluate(() => {
    if (!window.viewer) return 'No window.viewer';
    return {
      controls: !!window.viewer.controls,
      controlsType: window.viewer.controls ? window.viewer.controls.constructor.name : null,
      target: window.viewer.controls && window.viewer.controls.target ? window.viewer.controls.target : null
    };
  });
  console.log('Controls Info:', viewerInfo);
  await browser.close();
})();
