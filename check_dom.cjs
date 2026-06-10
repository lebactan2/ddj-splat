const puppeteer = require('puppeteer');
const path = require('path');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  const inputUploadHandle = await page.$('#file-a');
  await inputUploadHandle.uploadFile(path.resolve('test_splat.splat'));
  await new Promise(r => setTimeout(r, 2000));
  
  const domInfo = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return 'No canvas found';
    const rect = canvas.getBoundingClientRect();
    const style = window.getComputedStyle(canvas);
    return {
      width: rect.width, height: rect.height,
      opacity: style.opacity, zIndex: style.zIndex,
      parent: canvas.parentElement ? canvas.parentElement.id : 'null',
      display: style.display, visibility: style.visibility
    };
  });
  console.log('DOM Info:', domInfo);
  await browser.close();
})();
