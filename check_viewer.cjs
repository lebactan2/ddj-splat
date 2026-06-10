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
      sceneCenter: window.viewer.calculatedSceneCenter,
      cameraPos: window.viewer.camera ? window.viewer.camera.position : null,
      scenes: window.viewer.getSceneCount()
    };
  });
  console.log('Viewer Info:', viewerInfo);
  await browser.close();
})();
