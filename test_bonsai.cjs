const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('LOG:', msg.text()));
  
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  
  await page.evaluate(async () => {
    await window.makeViewer();
    const url = 'https://huggingface.co/datasets/mkkellogg/gaussian-splats-3d-test-data/resolve/main/bonsai-7k-half.ksplat';
    await window.viewer.addSplatScene(url, {
      'format': 1, // KSplat
      'showLoadingUI': false
    });
    
    // Auto frame
    const scene = window.viewer.getSplatScene(0);
    const center = scene.splatBuffer.sceneCenter;
    let maxDist = scene.splatBuffer.maxSplatDistanceFromSceneCenter;
    window.viewer.camera.position.set(center.x, center.y + maxDist * 0.5, center.z + maxDist * 2.5);
    window.viewer.controls.target.copy(center);
    window.viewer.controls.update();
  });
  
  console.log('Bonsai loaded. Waiting 2s...');
  await new Promise(r => setTimeout(r, 2000));
  
  await page.screenshot({ path: 'screenshot3_bonsai.png' });
  console.log('Saved screenshot3_bonsai.png');
  
  await browser.close();
})();
