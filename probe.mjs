import puppeteer from 'puppeteer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: 'new', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil:'networkidle2', timeout:60000 });
await sleep(800);
await (await page.$('#file-a')).uploadFile('C:/Cut up splatting/Raspberry.sog'); await sleep(4000);
await (await page.$('#file-b')).uploadFile('C:/Cut up splatting/Raspberry.sog'); await sleep(6000);
const setCross = (v)=>page.evaluate(v=>{const c=document.querySelector('#crossfader');c.value=String(v);c.dispatchEvent(new Event('input',{bubbles:true}));},v);
const probe = ()=>page.evaluate(()=>({
  loaded: (window.viewer&&window.viewer.splatMesh)?window.viewer.splatMesh.getSceneCount():0,
  ov: window._lastOverlayOpacity,
  cfval: document.querySelector('#crossfader').value,
}));
await setCross(0); await sleep(1000); console.log('c0', JSON.stringify(await probe()));
await setCross(100); await sleep(1000); console.log('c100', JSON.stringify(await probe()));
await setCross(50); await sleep(1000); console.log('c50', JSON.stringify(await probe()));
console.log('errs', JSON.stringify(errs));
await browser.close();
