const puppeteer = require('puppeteer');
const path = require('path');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  const inputUploadHandle = await page.$('#file-a');
  await inputUploadHandle.uploadFile(path.resolve('test_splat.splat'));
  await new Promise(r => setTimeout(r, 2000));
  
  const bufferInfo = await page.evaluate(() => {
    if (!window.viewer) return 'No window.viewer';
    const scene = window.viewer.getSplatScene(0);
    if (!scene) return 'No scene';
    const buffer = scene.splatBuffer;
    return {
      center: buffer.sceneCenter ? buffer.sceneCenter : 'no sceneCenter',
      maxDist: buffer.maxSplatDistanceFromSceneCenter ? buffer.maxSplatDistanceFromSceneCenter : 'no maxDist'
    };
  });
  console.log('Buffer Info:', bufferInfo);
  await browser.close();
})();
