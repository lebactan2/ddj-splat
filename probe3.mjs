import puppeteer from 'puppeteer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: 'new', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto('http://localhost:5173/', { waitUntil:'networkidle2', timeout:60000 });
await sleep(800);
await (await page.$('#file-a')).uploadFile('C:/Cut up splatting/Raspberry.sog'); await sleep(4000);
await (await page.$('#file-b')).uploadFile('C:/Cut up splatting/Raspberry.sog'); await sleep(10000);
const setCross = (v)=>page.evaluate(v=>{const c=document.querySelector('#crossfader');c.value=String(v);c.dispatchEvent(new Event('input',{bubbles:true}));},v);
const probe = ()=>page.evaluate(()=>{
  const cams = window._camRig && window._camRig.deckCameras;
  return {
    sceneA: !!window.viewer, // placeholder
    loadedKeys: (function(){ const o=[]; return o; })(),
    ov: {...window._lastOverlayOpacity},
  };
});
// sample many times at cross=0
await setCross(0);
for(let i=0;i<8;i++){ await sleep(250); const o=await page.evaluate(()=>({...window._lastOverlayOpacity})); console.log('c0 sample',i,JSON.stringify(o)); }
await setCross(100);
for(let i=0;i<8;i++){ await sleep(250); const o=await page.evaluate(()=>({...window._lastOverlayOpacity})); console.log('c100 sample',i,JSON.stringify(o)); }
await browser.close();
