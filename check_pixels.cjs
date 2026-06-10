const puppeteer = require('puppeteer');
const path = require('path');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  const inputUploadHandle = await page.$('#file-a');
  await inputUploadHandle.uploadFile(path.resolve('test_splat.splat'));
  await new Promise(r => setTimeout(r, 3000)); // wait 3s for render
  
  const colors = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const pixels = new Uint8Array(4);
    // Read center pixel
    gl.readPixels(canvas.width / 2, canvas.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    
    // Read a few more pixels
    const p2 = new Uint8Array(4);
    gl.readPixels(canvas.width / 2 + 10, canvas.height / 2 + 10, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p2);
    return { center: Array.from(pixels), offCenter: Array.from(p2) };
  });
  console.log('Pixels:', colors);
  await browser.close();
})();
